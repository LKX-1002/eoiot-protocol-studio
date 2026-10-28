import {
  bcdLittleEndian,
  checksumDiagnostics,
  field,
  findFrameStart,
  formatNumber,
  hex,
  hexByte,
  meterAddress,
  safeSlice,
  validateFrameEnvelope,
} from "./bytes";
import { parseJoymeterStatus } from "./joymeter-status";
import { getWaterMeterType } from "./meter-types";
import type { Diagnostic, ParseResult, ProtocolParser } from "./types";

const DATA_IDENTIFIER = "901F";
const CONTROL_NAMES: Record<number, string> = {
  0x01: "抄表请求",
  0x81: "抄表应答",
};

const FLOW_UNITS: Record<number, { factor: number; source: string }> = {
  0x29: { factor: 0.001, source: "升（L）" },
  0x2c: { factor: 0.01, source: "10 升" },
  0x2d: { factor: 0.1, source: "100 升" },
  0x2e: { factor: 1, source: "立方米" },
};

interface FlowValue {
  value: number | null;
  unitCode: number;
  sourceLabel: string;
}

function parseFlow(bytes: number[], offset: number): FlowValue {
  const raw = bcdLittleEndian(safeSlice(bytes, offset, 4));
  const unitCode = bytes[offset + 4] ?? -1;
  const unit = FLOW_UNITS[unitCode];
  return {
    value: raw === null || !unit ? null : raw * unit.factor,
    unitCode,
    sourceLabel: unit?.source ?? "未定义单位码",
  };
}

/** MBus 示例时间顺序为世纪、年、月、日、时、分、秒，均为 BCD。 */
function parseMeterTime(raw: number[]): string {
  if (raw.length !== 7) return "—";
  if (raw.every((value) => value === 0xff)) return "无";
  if (raw.some((value) => (value & 0x0f) > 9 || value >> 4 > 9)) return "—";
  const [century, year, month, day, hour, minute, second] = raw.map(hexByte);
  return `${century}${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function isValidAddress(address: number[]): boolean {
  if (address.length !== 7) return false;
  if (address.every((value) => value === 0xaa)) return true;
  return address.every((value) => (value & 0x0f) <= 9 && value >> 4 <= 9);
}

function hasValidChecksum(bytes: number[], start: number): boolean {
  if (start < 0 || bytes.at(-1) !== 0x16 || bytes.length < 2) return false;
  const calculated = bytes.slice(start, -2).reduce((sum, value) => (sum + value) & 0xff, 0);
  return bytes.at(-2) === calculated;
}

/** 小口径水表 · MBus 的 901FH 抄表请求与应答解析器。 */
export const joymeterMbusParser: ProtocolParser = {
  id: "joymeter-mbus",
  name: "小口径水表 · MBus",
  category: "water",
  status: "ready",

  detect(bytes) {
    const start = findFrameStart(bytes);
    if (start < 0 || bytes.length < start + 16) return 0;
    const dataLength = bytes[start + 10] ?? -1;
    const di = hex(safeSlice(bytes, start + 11, 2)).replaceAll(" ", "");
    if (di !== DATA_IDENTIFIER) return 0;
    let score = 70;
    if (bytes.length - start === dataLength + 13) score += 10;
    if (bytes[start + 1] === 0x10 || bytes[start + 1] === 0x11) score += 5;
    if (CONTROL_NAMES[bytes[start + 9]]) score += 5;
    if (isValidAddress(safeSlice(bytes, start + 2, 7))) score += 5;
    if (hasValidChecksum(bytes, start)) score += 5;
    return Math.min(score, 100);
  },

  validate(bytes) {
    const start = findFrameStart(bytes);
    validateFrameEnvelope(bytes, start);
    const typeCode = bytes[start + 1];
    if (typeCode !== 0x10 && typeCode !== 0x11)
      throw new Error(
        `仪表类型错误：小口径水表 · MBus 仅定义 10H 冷水表和 11H 热水表，收到 ${hexByte(typeCode ?? 0)}H。`,
      );
    if (!isValidAddress(safeSlice(bytes, start + 2, 7)))
      throw new Error("表地址错误：应为 7 字节 BCD 地址或全 AA 广播地址。");
    const control = bytes[start + 9];
    if (!CONTROL_NAMES[control])
      throw new Error(`控制码错误：小口径水表 · MBus 901FH 未定义 ${hexByte(control ?? 0)}H。`);
    const declaredLength = bytes[start + 10];
    const actualLength = bytes.length - start - 13;
    if (declaredLength !== actualLength)
      throw new Error(`长度字段错误：声明 ${declaredLength} Bytes，实际 ${actualLength} Bytes。`);
    const di = hex(safeSlice(bytes, start + 11, 2)).replaceAll(" ", "");
    if (di !== DATA_IDENTIFIER)
      throw new Error(
        `数据标识错误：小口径水表 · MBus 抄表应为 ${DATA_IDENTIFIER}H，收到 ${di || "空"}。`,
      );
    const expectedLength = control === 0x01 ? 3 : 22;
    if (declaredLength !== expectedLength)
      throw new Error(
        `${CONTROL_NAMES[control]}的数据区应为 ${expectedLength} Bytes，当前为 ${declaredLength} Bytes。`,
      );
  },

  parse(bytes): ParseResult {
    const start = findFrameStart(bytes);
    const type = getWaterMeterType(bytes[start + 1]);
    if (!type) throw new Error("无法解析仪表类型。");
    const controlOffset = start + 9;
    const lengthOffset = start + 10;
    const dataOffset = start + 11;
    const dataLength = bytes[lengthOffset];
    const checksumOffset = dataOffset + dataLength;
    const isResponse = bytes[controlOffset] === 0x81;
    const diagnostics: Diagnostic[] = checksumDiagnostics(bytes, start);
    const fields: ParseResult["fields"] = [];

    if (start > 0)
      fields.push(
        field(bytes, 0, start, "唤醒字节", `${start} 个 FE`, {
          note: "不参与 CS 计算",
          tone: "meta",
        }),
      );
    fields.push(
      field(bytes, start, 1, "帧起始符", "68H", { tone: "header" }),
      field(bytes, start + 1, 1, "仪表类型", type.label, { note: type.codeLabel, tone: "meta" }),
      field(bytes, start + 2, 7, "表地址", meterAddress(bytes, start), {
        note: "7 字节 BCD，低位在前",
        tone: "meta",
      }),
      field(bytes, controlOffset, 1, "控制码", CONTROL_NAMES[bytes[controlOffset]], {
        note: `${hexByte(bytes[controlOffset])}H`,
        tone: "header",
      }),
      field(bytes, lengthOffset, 1, "数据长度 L", `${dataLength} Bytes`, {
        note: "从数据标识 DI 至 CS 前一字节",
        tone: "meta",
      }),
      field(bytes, dataOffset, 2, "数据标识 DI", DATA_IDENTIFIER, {
        note: "抄读累计量与水表状态",
        tone: "meta",
      }),
      field(bytes, dataOffset + 2, 1, "流水号 SER", String(bytes[dataOffset + 2]), {
        tone: "meta",
      }),
    );

    let currentFlow: FlowValue | null = null;
    let settlementFlow: FlowValue | null = null;
    let meterTime = "—";
    let valveStatus = "—";
    let statusText = "—";
    let statusWord = "—";
    let statusItems: ReturnType<typeof parseJoymeterStatus>["items"] = [];

    if (isResponse) {
      const currentOffset = dataOffset + 3;
      const settlementOffset = dataOffset + 8;
      const timeOffset = dataOffset + 13;
      const statusOffset = dataOffset + 20;
      currentFlow = parseFlow(bytes, currentOffset);
      settlementFlow = parseFlow(bytes, settlementOffset);
      meterTime = parseMeterTime(safeSlice(bytes, timeOffset, 7));
      const status = parseJoymeterStatus(safeSlice(bytes, statusOffset, 2));
      valveStatus = status.valveStatus;
      const valveAbnormal =
        status.valveCode === 3 ? "阀门异常" : status.valveCode === 2 ? "阀门状态码保留" : null;
      const abnormalLabels = [...(valveAbnormal ? [valveAbnormal] : []), ...status.alarms];
      statusText = abnormalLabels.join("、") || "无异常";
      statusWord = `0x${status.rawHex}`;
      statusItems = status.items.filter((item) => item.active);
      if (valveAbnormal)
        statusItems.unshift({
          key: "valveAlarm",
          label: "阀门状态",
          active: true,
          value: valveAbnormal,
        });

      fields.push(
        field(bytes, currentOffset, 4, "当前累计流量", formatNumber(currentFlow.value, 3), {
          unit: "m³",
          note: "4 字节 BCD，低位在前",
          tone: "value",
        }),
        field(bytes, currentOffset + 4, 1, "当前流量单位", currentFlow.sourceLabel, {
          note: `单位码 ${hexByte(currentFlow.unitCode)}H`,
          tone: "value",
        }),
        field(bytes, settlementOffset, 4, "结算日累计流量", formatNumber(settlementFlow.value, 3), {
          unit: "m³",
          note: "4 字节 BCD，低位在前",
          tone: "value",
        }),
        field(bytes, settlementOffset + 4, 1, "结算流量单位", settlementFlow.sourceLabel, {
          note: `单位码 ${hexByte(settlementFlow.unitCode)}H`,
          tone: "value",
        }),
        field(bytes, timeOffset, 7, "水表时间", meterTime, {
          note: "世纪、年、月、日、时、分、秒，BCD",
          tone: "meta",
        }),
        field(bytes, statusOffset, 2, "水表状态 ST", statusText, {
          note: `${statusWord}，仅展示异常位；低字节在前`,
          tone: "status",
        }),
      );

      const invalidFlows = [currentFlow, settlementFlow].filter((item) => item.value === null);
      diagnostics.push(
        invalidFlows.length
          ? { level: "warn", text: `${invalidFlows.length} 个流量字段的 BCD 或单位码无法识别。` }
          : { level: "ok", text: "当前累计量与结算日累计量已完成 BCD 和单位换算。" },
      );
      diagnostics.push(
        statusItems.length
          ? { level: "warn", text: `状态字 ${statusWord}：${statusText}。` }
          : { level: "ok", text: `状态字 ${statusWord}：未检测到设备告警。` },
      );
    } else {
      diagnostics.push({ level: "ok", text: "小口径水表 · MBus 901FH 抄表请求已识别。" });
    }

    fields.push(
      field(bytes, checksumOffset, 1, "校验和 CS", hexByte(bytes[checksumOffset]), {
        note: "从 68 至 DATA 末字节累加取低 8 位",
        tone: "check",
      }),
      field(bytes, checksumOffset + 1, 1, "结束符", "16H", { tone: "header" }),
    );

    const overviewSections: ParseResult["overviewSections"] = [
      {
        id: "meter",
        title: "仪表与报文",
        items: [
          { key: "meterType", label: "仪表类型", value: `${type.label} · ${type.codeLabel}` },
          { key: "meterNo", label: "表号", value: meterAddress(bytes, start) },
          { key: "command", label: "报文用途", value: CONTROL_NAMES[bytes[controlOffset]] },
          {
            key: "dataLength",
            label: "长度",
            value: `${hexByte(dataLength)}H（${dataLength} Bytes）`,
          },
        ],
      },
    ];
    if (isResponse)
      overviewSections.push(
        {
          id: "flow",
          title: "抄表数据",
          items: [
            {
              key: "currentFlow",
              label: "当前累计流量",
              value: currentFlow?.value ?? null,
              unit: "m³",
            },
            {
              key: "settlementFlow",
              label: "结算日累计流量",
              value: settlementFlow?.value ?? null,
              unit: "m³",
            },
            { key: "meterTime", label: "水表时间", value: meterTime },
            { key: "statusWord", label: "状态字", value: statusWord, note: "两字节，低字节在前" },
          ],
        },
        {
          id: "status",
          title: "水表异常状态",
          items: statusItems.length
            ? statusItems.map((item) => ({ key: item.key, label: item.label, value: item.value }))
            : [{ key: "statusNormal", label: "异常状态", value: "无异常" }],
        },
      );

    return {
      protocol: `小口径水表 · MBus · ${CONTROL_NAMES[bytes[controlOffset]]}`,
      protocolId: this.id,
      category: "water",
      categoryLabel: "小口径水表 · MBus",
      manufacturer: "小口径水表 · MBus",
      confidence: this.detect(bytes),
      meterNo: meterAddress(bytes, start),
      controlCode: `${hexByte(bytes[controlOffset])}H`,
      dataIdentifier: DATA_IDENTIFIER,
      dataLength,
      coreValue:
        currentFlow?.value == null
          ? CONTROL_NAMES[bytes[controlOffset]]
          : `${formatNumber(currentFlow.value, 3)} m³`,
      metrics: {
        currentFlow: currentFlow?.value ?? null,
        settlementFlow: settlementFlow?.value ?? null,
        meterTime,
        valveStatus,
        statusInfo: statusText,
        statusWord,
        reportReason: isResponse ? "MBus 抄表应答" : "MBus 抄表请求",
        ...Object.fromEntries(statusItems.map((item) => [item.key, item.value])),
      },
      overviewSections,
      fields,
      diagnostics,
      history: [],
      rawBytes: bytes,
    };
  },
};
