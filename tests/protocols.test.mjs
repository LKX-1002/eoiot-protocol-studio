import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript as load } from "./load-typescript.mjs";
const { parseWithRegistry } = load("lib/protocols/registry.ts");
const { parseHex, hex } = load("lib/protocols/bytes.ts");
const { sampleList } = load("lib/protocols/samples.ts");
const { modbusCrc16, buildModbusReadRequest } = load("lib/protocols/modbus.ts");
const { calculateFrameChecksum } = load("lib/protocols/checksum-tool.ts");
const { buildDlt645ReadCommand } = load("lib/protocols/dlt645-command.ts");
const { buildAnalysisSummary } = load("lib/protocols/analysis.ts");
const { smallMeterStatus } = load("lib/protocols/water-status.ts");
const { waterOverview } = load("lib/protocols/water-overview.ts");
const { formatHexIfValid } = load("lib/protocols/format-input.ts");
const { electricProcess } = load("lib/protocols/electric-process.ts");

test("645解析过程与原始字节、解析值及校验和一致", () => {
  for (const sample of sampleList.filter((item) => item.protocolId === "dlt645-energy")) {
    const result = parseWithRegistry(parseHex(sample.value));
    const process = electricProcess(result);
    assert.equal(process.calculatedChecksum, process.receivedChecksum);
    assert.equal(process.di, result.dataIdentifier);
    assert.equal(process.decoded.split(" ").length, result.dataLength);
    assert.deepEqual(
      process.values.map((item) => item.value),
      result.fields.filter((item) => item.tone === "value").map((item) => item.value),
    );
  }
  const single = parseWithRegistry(
    parseHex("FE FE 68 13 79 02 00 03 48 68 91 08 33 33 34 33 89 67 45 33 77 16"),
  );
  const process = electricProcess(single);
  assert.equal(process.values[0].decoded, "56 34 12 00");
  assert.equal(process.values[0].ordered, "00 12 34 56");
  assert.equal(process.values[0].value, "1234.56");
});

test("输入格式化只整理完整合法字节，不修补错误输入", () => {
  assert.equal(formatHexIfValid("fefe6810"), "FE FE 68 10");
  assert.equal(formatHexIfValid("01 03 2"), "01 03 2");
  assert.equal(formatHexIfValid("01 ZZ"), "01 ZZ");
  for (const sample of sampleList) {
    assert.deepEqual(parseHex(formatHexIfValid(sample.value)), parseHex(sample.value));
  }
});

test("9025采集与历史摘要保留本帧语义，不按帧数推断总条数", () => {
  const sample = sampleList.find((item) => item.name.includes("9025"));
  const result = parseWithRegistry(parseHex(sample.value));
  const model = waterOverview(result);
  assert.equal(result.metrics.collectionIntervalMinutes, 60);
  assert.equal(model.acquisition.frequency, "每小时 1 次");
  assert.equal(model.acquisition.declaredCount, 12);
  assert.equal(model.acquisition.actualCount, 12);
  assert.equal(model.acquisition.frameIndex, 2);
  assert.equal(model.acquisition.totalFrames, 2);
  assert.equal(model.acquisition.firstTime, "2026-08-30 19:00");
  assert.equal(model.acquisition.realtime, "2026-08-31 06:00:59");
  const zeroInterval = waterOverview({
    ...result,
    metrics: { ...result.metrics, collectionIntervalMinutes: 0 },
  });
  assert.equal(zeroInterval.acquisition.intervalMinutes, null);
  assert.equal(zeroInterval.acquisition.frequency, "无法换算");
  const truncated = waterOverview({ ...result, history: result.history.slice(0, 3) });
  assert.equal(truncated.acquisition.actualCount, 3);
  assert.equal(truncated.acquisition.declaredCount, 12);
});

test("水表概览去重：顶部读数不重复，MBus无信号，大口径仅CSQ", () => {
  for (const sample of sampleList.filter((item) =>
    ["cjt188-small", "joymeter-mbus", "wotman-big"].includes(item.protocolId),
  )) {
    const result = parseWithRegistry(parseHex(sample.value));
    const view = waterOverview(result);
    const detailKeys = view.technical.flatMap((section) => section.items.map((item) => item.key));
    for (const key of [
      "currentFlow",
      "forwardFlow",
      "settlementFlow",
      "meterTime",
      "collectTime",
      "meterNo",
      "statusInfo",
      "statusWord",
    ])
      assert.equal(detailKeys.includes(key), false);
    assert.equal(new Set(detailKeys).size, detailKeys.length);
    if (result.protocolId === "joymeter-mbus") assert.equal(view.signals.length, 0);
    if (result.protocolId === "wotman-big")
      assert.deepEqual(
        view.signals.map((item) => item.key),
        result.metrics.csq == null ? [] : ["csq"],
      );
    for (const key of view.measurements.map((item) => item.key))
      assert.equal(detailKeys.includes(key), false);
  }
});

test("大口径概览不展示瞬时流量，保留上线计数与真实时间来源", () => {
  for (const sample of sampleList.filter((item) => item.protocolId === "wotman-big")) {
    const result = parseWithRegistry(parseHex(sample.value));
    const view = waterOverview(result);
    assert.equal(
      view.measurements.some((item) => item.key === "instantFlow"),
      false,
    );
    for (const key of ["successCount", "failureCount"]) {
      assert.equal(view.equipment.find((item) => item.key === key)?.value, result.metrics[key]);
      assert.equal(
        view.technical.some((section) => section.items.some((item) => item.key === key)),
        false,
      );
    }
    assert.equal(view.acquisition.realtime, result.metrics.collectTime);
    assert.equal(view.reportReason, "水表主动上报");
  }
});

test("小口径4G与MBus共用异常状态：正常、关阀、告警、阀门故障和未知", () => {
  for (const protocolId of ["cjt188-small", "joymeter-mbus"]) {
    const base = { protocolId, metrics: {} };
    const status = (statusWord) => smallMeterStatus({ ...base, metrics: { statusWord } });
    assert.equal(status("0x0000").label, "无异常状态");
    assert.equal(status("0x0001").label, "无异常状态");
    assert.deepEqual(status("0x0204").alarms, ["电池欠压", "磁干扰异常"]);
    assert.deepEqual(status("0x0003").alarms, ["阀门异常"]);
    assert.equal(status("0x0002").state, "unknown");
    for (const word of [null, undefined, "—", "", "0x0", "not-hex"]) {
      assert.equal(status(word).state, "unknown");
    }
    const sample = sampleList.find((item) => item.protocolId === protocolId);
    const parsed = parseWithRegistry(parseHex(sample.value));
    assert.match(parsed.metrics.statusWord, /^0x[0-9A-F]{4}$/);
    assert.notEqual(smallMeterStatus(parsed).state, "unknown");
  }
});
const config = {
  rangeMode: "all",
  dataType: "UINT16",
  byteOrder: "AB",
  scale: 1,
  unit: "",
  registerOffset: 0,
  valueCount: 1,
  label: "解析值",
  decimals: 2,
};
function response(data) {
  const bytes = [1, 3, data.length, ...data];
  const crc = modbusCrc16(bytes);
  return [...bytes, crc & 255, crc >>> 8];
}
const decode = (bytes, patch = {}) =>
  parseWithRegistry(bytes, "modbus-rtu", { modbusDecode: { ...config, ...patch } });

for (const sample of sampleList)
  test(`协议样例：${sample.name}`, () => {
    const bytes = parseHex(sample.value);
    const result = parseWithRegistry(bytes);
    assert.equal(result.protocolId, sample.protocolId);
    if (sample.id === "dlt645-single-energy") assert.equal(result.metrics.totalEnergy, 1234.56);
    if (sample.id === "dlt645-multi-energy") {
      assert.equal(result.metrics.totalEnergy, 1000);
      assert.equal(result.metrics.tipEnergy, 100);
      assert.equal(result.metrics.peakEnergy, 200);
      assert.equal(result.metrics.flatEnergy, 300);
      assert.equal(result.metrics.valleyEnergy, 400);
    }
    assert.equal(result.rawBytes.length, bytes.length);
    assert.ok(result.fields.every((field) => field.offset + field.length <= bytes.length));
    assert.equal(calculateFrameChecksum(bytes.slice(0, -2), "cs").frame, hex(bytes));
    const damaged = [...bytes];
    damaged[damaged.length - 2] ^= 1;
    assert.throws(() => parseWithRegistry(damaged));
    assert.throws(() => parseWithRegistry(bytes.slice(0, -1)));
  });
test("HEX 输入和未知协议不被强行识别为 Modbus", () => {
  assert.deepEqual(parseHex("0x01, 0x03\n00-29"), [1, 3, 0, 41]);
  assert.throws(() => parseHex("010"));
  assert.throws(() => parseHex("ZZ"));
  assert.throws(() => parseWithRegistry(parseHex("FEFE")), /暂未识别/);
});
test("Modbus 已知 CRC 和请求边界", () => {
  assert.equal(hex(buildModbusReadRequest(1, 3, 41, 1)), "01 03 00 29 00 01 55 C2");
  for (const args of [
    [0, 3, 0, 1],
    [248, 3, 0, 1],
    [1, 6, 0, 1],
    [1, 3, 65535, 2],
    [1, 3, 0, 126],
  ])
    assert.throws(() => buildModbusReadRequest(...args));
  assert.equal(
    parseWithRegistry(buildModbusReadRequest(1, 4, 65535, 1)).metrics.registerStart,
    65535,
  );
});
test("真实 FLOAT32 帧与倍率", () => {
  const result = decode(parseHex("9303044C30F0E01AED"), {
    dataType: "FLOAT32",
    byteOrder: "ABCD",
    scale: 0.001,
    unit: "kWh",
  });
  assert.equal(result.metrics.decodedValue, 46384);
  assert.equal(result.metrics.decodedCount, 1);
});
test("Modbus 字节序、有符号数、自动范围、自定义范围及旧配置", () => {
  assert.equal(decode(response([0x76, 4]), { byteOrder: "BA" }).metrics.decodedValue, 1142);
  assert.equal(decode(response([255, 254]), { dataType: "INT16" }).metrics.decodedValue, -2);
  for (const [order, bytes] of [
    ["ABCD", [0x44, 0x34, 0x07, 0xae]],
    ["CDAB", [0x07, 0xae, 0x44, 0x34]],
    ["BADC", [0x34, 0x44, 0xae, 0x07]],
    ["DCBA", [0xae, 0x07, 0x34, 0x44]],
  ]) {
    assert.ok(
      Math.abs(
        decode(response(bytes), { dataType: "FLOAT32", byteOrder: order }).metrics.decodedValue -
          720.12,
      ) < 0.0001,
    );
  }
  const bytes = response([0, 1, 0, 2, 0, 3, 0, 4]);
  assert.equal(decode(bytes).metrics.decodedCount, 4);
  assert.equal(
    decode(bytes, { rangeMode: "custom", registerOffset: 1, valueCount: 1 }).metrics.decodedValue,
    2,
  );
  assert.equal(decode(bytes, { rangeMode: undefined }).metrics.decodedCount, 1);
  assert.throws(
    () => decode(response([0, 1, 0, 2, 0, 3]), { dataType: "FLOAT32", byteOrder: "ABCD" }),
    /不能按/,
  );
  assert.throws(() => decode(bytes, { rangeMode: "custom", registerOffset: 4 }), /数据不足/);
  const saved = JSON.parse(decode(bytes).metrics.decodeConfig);
  assert.equal(decode(bytes, saved).metrics.decodedCount, 4);
});
test("校验工具已知结果与 FE 排除", () => {
  assert.equal(calculateFrameChecksum(parseHex("010300290001"), "modbus").checksum, "55 C2");
  assert.equal(
    calculateFrameChecksum(parseHex("FEFE6802000000000068110433333433"), "cs").checksum,
    "B4",
  );
  assert.throws(() => calculateFrameChecksum([], "cs"));
  assert.throws(() => calculateFrameChecksum(parseHex("6802000000000068110433333433B416"), "cs"));
});
test("645 已知抄读指令与非法参数", () => {
  assert.equal(
    buildDlt645ReadCommand("2", "00010000", 0).frame,
    "68 02 00 00 00 00 00 68 11 04 33 33 34 33 B4 16",
  );
  for (const args of [
    ["", "00010000"],
    ["AA", "00010000"],
    ["1234567890123", "00010000"],
    ["1", "GG000000"],
    ["1", "00010000", 5],
  ])
    assert.throws(() => buildDlt645ReadCommand(...args));
});
function electricReply(di, values) {
  const data = [...parseHex(di).reverse(), ...values.flat()];
  const bytes = [
    0x68,
    2,
    0,
    0,
    0,
    0,
    0,
    0x68,
    0x91,
    data.length,
    ...data.map((byte) => (byte + 0x33) & 255),
  ];
  return [...bytes, bytes.reduce((sum, byte) => (sum + byte) & 255, 0), 0x16];
}
test("645三类有功的全部预设：生成请求与应答解析范围一致", () => {
  for (const kind of ["00", "01", "02"])
    for (const rate of ["00", "01", "02", "03", "04", "05", "06", "07", "08", "FF"]) {
      const di = `00${kind}${rate}00`;
      const request = buildDlt645ReadCommand("2", di, 4);
      assert.equal(parseWithRegistry(parseHex(request.frame)).dataIdentifier, di);
      const result = parseWithRegistry(electricReply(di, [[0x12, 0, 0, 0]]));
      assert.equal(result.coreValue, "0.12 kWh");
      assert.equal(
        result.metrics.energyType,
        { "00": "组合有功", "01": "正向有功", "02": "反向有功" }[kind],
      );
      if (rate !== "00" && rate !== "FF") {
        assert.equal(result.metrics.totalEnergy, undefined);
        const summary = buildAnalysisSummary(result);
        assert.equal(summary.items[0].value, "0.12 kWh");
        assert.equal(summary.items[0].label, `费率 ${parseInt(rate, 16)} 电量`);
      }
    }
});
test("645四费率与八费率数据块、符号位和非法BCD", () => {
  const block = parseWithRegistry(
    electricReply("0002FF00", [
      [0x36, 0, 0, 0],
      ...Array.from({ length: 8 }, (_, i) => [i + 1, 0, 0, 0]),
    ]),
  );
  assert.equal(block.metrics.totalEnergy, 0.36);
  assert.equal(block.metrics.tariffSum, 0.36);
  assert.equal(block.metrics.rate8Energy, 0.08);
  assert.equal(block.overviewSections.find((s) => s.id === "energy").items.length, 9);
  assert.equal(
    parseWithRegistry(electricReply("00000000", [[0x12, 0, 0, 0x80]])).coreValue,
    "-0.12 kWh",
  );
  assert.throws(() => parseWithRegistry(electricReply("00020000", [[0xfa, 0, 0, 0]])), /BCD/);
  assert.throws(() => parseWithRegistry(electricReply("02010100", [[0, 0, 0, 0]])), /自定义 DI/);
});
