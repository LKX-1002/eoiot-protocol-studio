import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript as load } from "./load-typescript.mjs";
const { createLocalRecordStore, createParseRecord, RECORD_STORAGE_KEY, isModbusDecodeConfig } =
  load("lib/records/record-store.ts");
const { parseWithRegistry } = load("lib/protocols/registry.ts");
const { parseHex } = load("lib/protocols/bytes.ts");
const record = {
  id: "record-1",
  createdAt: "2026-10-27T00:00:00.000Z",
  protocol: "Modbus RTU",
  coreValue: "11.42 kWh",
  meterNo: "1",
  raw: "01 03 02 04 76 3B 62",
};
function memory(initial) {
  const map = new Map(initial === undefined ? [] : [[RECORD_STORAGE_KEY, initial]]);
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}
for (const source of [
  "null",
  "{}",
  "[null]",
  "{broken",
  JSON.stringify([{ ...record, createdAt: "bad-date" }]),
])
  test(`损坏记录安全读取：${source.slice(0, 30)}`, () => {
    const storage = memory(source),
      store = createLocalRecordStore(() => storage);
    const result = store.load();
    assert.deepEqual(result.records, []);
    assert.ok(result.notice);
    assert.equal(result.writable, false);
    assert.equal(storage.getItem(RECORD_STORAGE_KEY), source);
  });
test("旧记录数组迁移为版本化记录，保留前导零及原始报文", () => {
  const storage = memory(JSON.stringify([{ ...record, meterNo: "000000000001" }]));
  const store = createLocalRecordStore(() => storage),
    loaded = store.load();
  assert.equal(loaded.records[0].meterNo, "000000000001");
  assert.equal(loaded.writable, true);
  assert.equal(store.save(loaded.records).ok, true);
  const saved = JSON.parse(storage.getItem(RECORD_STORAGE_KEY));
  assert.equal(saved.version, 1);
  assert.equal(saved.records[0].raw, record.raw);
  assert.equal(store.load().records.length, 1);
});
test("部分损坏时只载入有效项，不覆盖原始数据", () => {
  const original = JSON.stringify([null, record]);
  const storage = memory(original);
  const loaded = createLocalRecordStore(() => storage).load();
  assert.equal(loaded.records.length, 1);
  assert.match(loaded.notice, /1 条/);
  assert.equal(loaded.writable, false);
  assert.equal(storage.getItem(RECORD_STORAGE_KEY), original);
});
test("未知版本保留原始数据", () => {
  const original = JSON.stringify({ version: 999, records: [record] });
  const storage = memory(original);
  const loaded = createLocalRecordStore(() => storage).load();
  assert.equal(loaded.writable, false);
  assert.equal(storage.getItem(RECORD_STORAGE_KEY), original);
});
test("存储访问、写入与删除失败返回提示，不抛出异常", () => {
  const blocked = createLocalRecordStore(() => {
    throw new Error("SecurityError");
  });
  assert.ok(blocked.load().notice);
  assert.equal(blocked.save([record]).ok, false);
  assert.equal(blocked.clear().ok, false);
  const storage = memory();
  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.equal(createLocalRecordStore(() => storage).save([record]).ok, false);
});
test("最多保存20条；清空及删除后的保存", () => {
  const storage = memory(),
    store = createLocalRecordStore(() => storage);
  store.save(Array.from({ length: 30 }, (_, i) => ({ ...record, id: String(i) })));
  assert.equal(store.load().records.length, 20);
  store.save(store.load().records.filter((item) => item.id !== "0"));
  assert.equal(store.load().records.length, 19);
  assert.equal(store.clear().ok, true);
  assert.deepEqual(store.load().records, []);
});
test("Modbus范围、字节序与倍率配置验证和持久化", () => {
  const config = {
    rangeMode: "all",
    dataType: "FLOAT32",
    byteOrder: "ABCD",
    scale: 1,
    unit: "Wh",
    registerOffset: 0,
    valueCount: 1,
    label: "解析值",
    decimals: 2,
  };
  assert.equal(isModbusDecodeConfig(config), true);
  for (const patch of [
    { dataType: "UNKNOWN" },
    { byteOrder: "AB" },
    { scale: Infinity },
    { valueCount: 0 },
    { decimals: 10 },
    { rangeMode: "unknown" },
  ])
    assert.equal(isModbusDecodeConfig({ ...config, ...patch }), false);
  const parsed = parseWithRegistry(parseHex("9303044C30F0E01AED"), "auto", {
    modbusDecode: config,
  });
  const saved = createParseRecord(parsed, "9303044C30F0E01AED");
  const storage = memory();
  const store = createLocalRecordStore(() => storage);
  assert.equal(store.save([saved]).ok, true);
  assert.equal(saved.modbusDecode.rangeMode, "all");
  assert.equal(store.load().records[0].modbusDecode.rangeMode, "all");
  assert.ok(saved.id);
});
