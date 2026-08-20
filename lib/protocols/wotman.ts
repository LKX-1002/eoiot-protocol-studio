import {
  bcdInOrder,
  bcdLittleEndian,
  checksumDiagnostics,
  field,
  findFrameStart,
  float32,
  formatNumber,
  hex,
  hexByte,
  meterAddress,
  parseReverseBcdTime,
  safeSlice,
  uint,
  validateFrameEnvelope,
} from "./bytes";
import type { Diagnostic, HistoryItem, ParseOptions, ParseResult, ProtocolParser } from "./types";
import { getWaterMeterType } from "./meter-types";

/** 三个告警字节由高位到低位对应的业务含义，内容来自原 Java 源码。 */
const WARNINGS = [
  ["设备内部高温", "内部温度传感器故障/空管", "水温传感器故障", "数据被更改", "内部数据错误", "存储器故障", "电池电量严重不足", "电池电量低"],
  ["反向流量", "持续高流量", "持续低流量", "水压力低", "水压力高", "压力传感器故障", "水低温", "水高温"],
  ["长时间无流量", "", "", "水表电池拆卸", "水表内部模块拆卸", "水表内部模块受干扰", "水表内部模块故障", "阀门故障"],
];

/**
 * 按 A-F 类型指示解析数值：
 * 1=无符号整数，2=带符号 BCD，3=IEEE 754 Float。
 */
function typedValue(type: string, valueBytes: number[], decimals: number, floatEndian: "be" | "le" = "be"): number | null {
  if (valueBytes.length === 0) return null;
  if (type === "1") return uint(valueBytes, "be") / 10 ** decimals;
  if (type === "2") {
    // BCD 最高字节的最高位用于表示正负号，解析数字前先清除符号位。
    const signed = (valueBytes.at(-1) ?? 0) & 0x80 ? -1 : 1;
    const clean = [...valueBytes];
    clean[clean.length - 1] &= 0x7f;
    const parsed = bcdLittleEndian(clean, decimals);
    return parsed === null ? null : parsed * signed;
  }
  if (type === "3") return float32(valueBytes, floatEndian);
  return null;
}

/** 把 3 字节位图展开为中文告警列表。 */
function warningLabels(bytes: number[]): string[] {
  return bytes.flatMap((value, byteIndex) =>
    WARNINGS[byteIndex]
      .map((label, bitIndex) => ((value >> (7 - bitIndex)) & 1) === 1 ? label : "")
      .filter(Boolean),
  );
}

/** 9021、9023、9025 共用的内部解析结果。 */
interface BigWaterValues {
  dataNumber: number;
  history: HistoryItem[];
  forwardFlow: number | null;
  reverseFlow: number | null;
  instantFlow: number | null;
  pressure: number | null;
  temperature: number | null;
  meterVoltage: number | null;
  collectorVoltage: number | null;
  csq: number | null;
  imei: string;
  imsi: string;
  collectTime: string;
  valveStatus: string;
  statusInfo: string;
  warnings: string[];
  hardwareVersion: string;
  softwareVersion: string;
  fields: ParseResult["fields"];
  diagnostics: Diagnostic[];
}

/** 创建稳定的默认对象，确保短帧或可选字段缺失时界面仍可显示。 */
function emptyBigWater(): BigWaterValues {
  return {
    dataNumber: 0,
    history: [],
    forwardFlow: null,
    reverseFlow: null,
    instantFlow: null,
    pressure: null,
    temperature: null,
    meterVoltage: null,
    collectorVoltage: null,
    csq: null,
    imei: "—",
    imsi: "—",
    collectTime: "—",
    valveStatus: "未知",
    statusInfo: "—",
    warnings: [],
    hardwareVersion: "—",
    softwareVersion: "—",
    fields: [],
    diagnostics: [],
  };
}

/**
 * 解析沃特曼 9025 报文。
 * index 对应 Java 源码中的基础数据位置；随后按固定偏移读取时间、类型和记录区。
 */
function parse9025(bytes: number[], index: number, options: ParseOptions): BigWaterValues {
  const result = emptyBigWater();
  // 固定头之后依次为：条数 1B、首条时间 5B、间隔 1B、A-F 类型 3B。
  const countOffset = index + 5;
  const dataNumber = bytes[countOffset] ?? 0;
  result.dataNumber = dataNumber;
  const firstTimeOffset = index + 6;
  const firstTime = parseReverseBcdTime(safeSlice(bytes, firstTimeOffset, 5), options.century ?? "20");
  const intervalMinutes = bytes[index + 11] ?? 0;
  const typeOffset = index + 12;
  const typeBytes = safeSlice(bytes, typeOffset, 3);
  const typeHex = typeBytes.map(hexByte).join("").padEnd(6, "0");
  const [aType, bType, cType, dType, eType, fType] = typeHex.split("");
  // 每条历史记录固定 17 字节：A 5B + B 4B + C 4B + D 4B。
  const recordOffset = index + 15;
  const floatEndian = options.floatEndian ?? "be";
  const firstTimeMs = firstTime === "—" ? Number.NaN : new Date(firstTime.replace(" ", "T")).getTime();

  for (let i = 0; i < dataNumber; i += 1) {
    const offset = recordOffset + i * 17;
    if (offset + 17 > bytes.length) {
      result.diagnostics.push({ level: "warn", text: `历史数据声明 ${dataNumber} 条，但第 ${i + 1} 条字节不足。` });
      break;
    }
    const collectTime = Number.isFinite(firstTimeMs)
      ? new Date(firstTimeMs + intervalMinutes * 60_000 * i).toLocaleString("zh-CN", { hour12: false })
      : firstTime;
    result.history.push({
      collectTime,
      forwardFlow: typedValue(aType, safeSlice(bytes, offset, 5), aType === "1" ? 0 : 2, floatEndian) ?? undefined,
      // 原 Java 源码漏掉了 System.arraycopy；此处按协议读取真实 B 字段。
      reverseFlow: typedValue(bType, safeSlice(bytes, offset + 5, 4), bType === "1" ? 0 : 2, floatEndian) ?? undefined,
      instantFlow: typedValue(cType, safeSlice(bytes, offset + 9, 4), 3, floatEndian) ?? undefined,
      pressure: typedValue(dType, safeSlice(bytes, offset + 13, 4), 3, floatEndian) ?? undefined,
    });
  }

  // 历史区之后是当前 A-F 数据，使用游标顺序读取以降低手工偏移出错概率。
  let cursor = recordOffset + dataNumber * 17;
  result.forwardFlow = typedValue(aType, safeSlice(bytes, cursor, 5), aType === "1" ? 0 : 2, floatEndian); cursor += 5;
  result.reverseFlow = typedValue(bType, safeSlice(bytes, cursor, 4), bType === "1" ? 0 : 2, floatEndian); cursor += 4;
  result.instantFlow = typedValue(cType, safeSlice(bytes, cursor, 4), 3, floatEndian); cursor += 4;
  result.pressure = typedValue(dType, safeSlice(bytes, cursor, 4), 3, floatEndian); cursor += 4;
  result.temperature = typedValue(eType, safeSlice(bytes, cursor, 4), 3, floatEndian); cursor += 4;
  result.meterVoltage = typedValue(fType, safeSlice(bytes, cursor, 4), 3, floatEndian); cursor += 4;
  result.collectorVoltage = bcdLittleEndian(safeSlice(bytes, cursor, 2), 2); cursor += 2;
  result.csq = bcdLittleEndian(safeSlice(bytes, cursor, 1), 0); cursor += 1;
  // 原协议在 CSQ 与 IMEI 之间保留 9 字节通信参数。
  cursor += 9;
  result.imei = String(bcdInOrder(safeSlice(bytes, cursor, 8), 0) ?? "—"); cursor += 8;
  result.imsi = String(bcdInOrder(safeSlice(bytes, cursor, 8), 0) ?? "—"); cursor += 8;
  cursor += 4;
  result.collectTime = parseReverseBcdTime(safeSlice(bytes, cursor, 7).slice(0, 6), ""); cursor += 7;
  // 状态字 bit0=阀门，bit1=阀门故障，bit2=电池欠压。
  const statusOffset = cursor;
  const status = bytes[cursor] ?? 0; cursor += 2;
  result.valveStatus = (status & 0x01) === 1 ? "关闭" : "开启";
  const statusLabels = [(status & 0x02) ? "阀门故障" : "", (status & 0x04) ? "电池欠压" : ""].filter(Boolean);
  result.statusInfo = statusLabels.join("、") || "正常";
  const warningOffset = cursor;
  const warningBytes = safeSlice(bytes, cursor, 3); cursor += 3;
  result.warnings = warningLabels(warningBytes);
  result.hardwareVersion = formatNumber(bcdLittleEndian(safeSlice(bytes, cursor, 2), 2), 2); cursor += 2;
  result.softwareVersion = formatNumber(bcdLittleEndian(safeSlice(bytes, cursor, 2), 2), 2);

  // 记录关键业务区域；过细的设备标识仍保留在 metrics 和 JSON 中。
  result.fields.push(
    field(bytes, countOffset, 1, "历史数据条数", String(dataNumber), { tone: "meta" }),
    field(bytes, firstTimeOffset, 5, "首条采集时间", firstTime, { note: "BCD，倒序", tone: "meta" }),
    field(bytes, index + 11, 1, "采集间隔", String(intervalMinutes), { unit: "分钟", tone: "meta" }),
    field(bytes, typeOffset, 3, "A-F 数据类型", typeHex, { note: "1=整数，2=BCD，3=Float", tone: "meta" }),
    field(bytes, recordOffset, dataNumber * 17, "历史数据区", `${result.history.length} 条`, { note: "每条 17 字节", tone: "value" }),
    field(bytes, recordOffset + dataNumber * 17, 5, "当前正向累计流量", formatNumber(result.forwardFlow, 3), { unit: "m³", tone: "value" }),
    field(bytes, recordOffset + dataNumber * 17 + 5, 4, "当前反向累计流量", formatNumber(result.reverseFlow, 3), { unit: "m³", tone: "value" }),
    field(bytes, statusOffset, 1, "仪表状态", `${result.valveStatus} / ${result.statusInfo}`, { tone: "status" }),
    field(bytes, warningOffset, 3, "告警信息", result.warnings.join("、") || "无告警", { tone: "status" }),
  );
  result.diagnostics.push({ level: "ok", text: "9025 A-F 类型数据已按类型指示解析。" });
  result.diagnostics.push({ level: "ok", text: "历史反向流量已按每条 17 字节记录中的 B 字段读取。" });
  return result;
}

/**
 * 解析结构相近的 9021 / 9023 报文。
 * 两者主要差异是累计流量字段分别占 4 字节和 5 字节。
 */
function parse902x(bytes: number[], index: number, di: "9021" | "9023", options: ParseOptions): BigWaterValues {
  const result = emptyBigWater();
  const valueLength = di === "9021" ? 4 : 5;
  const dataNumber = bytes[index + 5] ?? 0;
  result.dataNumber = dataNumber;
  const firstTime = parseReverseBcdTime(safeSlice(bytes, index + 6, 5), options.century ?? "20");
  const intervalMinutes = bytes[index + 11] ?? 0;
  const historyOffset = index + 12;
  const firstTimeMs = firstTime === "—" ? Number.NaN : new Date(firstTime.replace(" ", "T")).getTime();
  // 历史区只记录累计流量，采集时间由首条时间和间隔推算。
  for (let i = 0; i < dataNumber; i += 1) {
    const raw = safeSlice(bytes, historyOffset + i * valueLength, valueLength);
    if (raw.length !== valueLength) break;
    const parsed = bcdLittleEndian(raw, 2);
    result.history.push({
      collectTime: Number.isFinite(firstTimeMs)
        ? new Date(firstTimeMs + intervalMinutes * 60_000 * i).toLocaleString("zh-CN", { hour12: false })
        : firstTime,
      forwardFlow: parsed === null ? undefined : di === "9023" ? parsed * 0.01 : parsed,
    });
  }
  // 当前累计量之后按照 Java 源码顺序读取瞬时量和通信模块信息。
  let cursor = historyOffset + dataNumber * valueLength;
  const currentRaw = safeSlice(bytes, cursor, valueLength);
  const current = bcdLittleEndian(currentRaw, 2);
  result.forwardFlow = current === null ? null : di === "9023" ? current * 0.01 : current; cursor += valueLength;
  result.instantFlow = typedValue("1", safeSlice(bytes, cursor, 2), 3); cursor += 2 + valueLength;
  result.meterVoltage = bcdLittleEndian(safeSlice(bytes, cursor, 2), 2); cursor += 2;
  result.csq = bcdLittleEndian(safeSlice(bytes, cursor, 1), 0); cursor += 1 + 9;
  result.imei = String(bcdInOrder(safeSlice(bytes, cursor, 8), 0) ?? "—"); cursor += 8;
  result.imsi = String(bcdInOrder(safeSlice(bytes, cursor, 8), 0) ?? "—"); cursor += 8 + 4;
  result.collectTime = parseReverseBcdTime(safeSlice(bytes, cursor, 7).slice(0, 6), ""); cursor += 7;
  const statusOffset = cursor;
  const status = bytes[cursor] ?? 0; cursor += 2;
  result.valveStatus = (status & 0x01) === 1 ? "关闭" : "开启";
  result.statusInfo = [(status & 0x02) ? "阀门故障" : "", (status & 0x04) ? "电池欠压" : ""].filter(Boolean).join("、") || "正常";
  const warningOffset = cursor;
  const warningBytes = safeSlice(bytes, cursor, 3); cursor += 3;
  result.warnings = warningLabels(warningBytes);
  result.hardwareVersion = formatNumber(bcdLittleEndian(safeSlice(bytes, cursor, 2), 2), 2); cursor += 2;
  result.softwareVersion = formatNumber(bcdLittleEndian(safeSlice(bytes, cursor, 2), 2), 2);
  result.fields.push(
    field(bytes, index + 5, 1, "历史数据条数", String(dataNumber), { tone: "meta" }),
    field(bytes, index + 6, 5, "首条采集时间", firstTime, { note: "BCD，倒序", tone: "meta" }),
    field(bytes, historyOffset, dataNumber * valueLength, "历史累计流量", `${result.history.length} 条`, { tone: "value" }),
    field(bytes, historyOffset + dataNumber * valueLength, valueLength, "当前累计流量", formatNumber(result.forwardFlow, 3), { unit: "m³", tone: "value" }),
    field(bytes, statusOffset, 1, "仪表状态", `${result.valveStatus} / ${result.statusInfo}`, { tone: "status" }),
    field(bytes, warningOffset, 3, "告警信息", result.warnings.join("、") || "无告警", { tone: "status" }),
  );
  result.diagnostics.push({ level: "ok", text: `${di} 历史累计流量与设备信息已解析。` });
  return result;
}

export const wotmanParser: ProtocolParser = {
  id: "wotman-big",
  name: "武汉沃特曼大口径水表",
  category: "water",
  status: "ready",
  /** 9021、9023、9025 DI 是沃特曼解析器最强的识别依据。 */
  detect(bytes) {
    const start = findFrameStart(bytes);
    if (start < 0) return 0;
    const controlOffset = start + 9;
    const di = hex(safeSlice(bytes, controlOffset + 3, 2)).replace(" ", "");
    let score = ["9021", "9023", "9025"].includes(di) ? 75 : 10;
    if (bytes[start + 1] === 0x10) score += 10;
    if ([0x81, 0x01].includes(bytes[controlOffset])) score += 5;
    if (bytes.at(-1) === 0x16) score += 10;
    return Math.min(score, 100);
  },
  /** 校验沃特曼公共帧头、总长度和已接入的数据标识。 */
  validate(bytes, options = {}) {
    const start = findFrameStart(bytes);
    validateFrameEnvelope(bytes, start);
    if (!getWaterMeterType(bytes[start + 1])) {
      throw new Error(`仪表类型错误：${hexByte(bytes[start + 1] ?? 0)}H 不属于水表类型 10H–19H。`);
    }
    const controlOffset = start + 9;
    if (![0x81, 0x01].includes(bytes[controlOffset])) {
      throw new Error(`控制码错误：暂不支持 ${hexByte(bytes[controlOffset] ?? 0)}H。`);
    }
    const dataIdentifier = hex(safeSlice(bytes, controlOffset + 3, 2)).replace(" ", "");
    if (!["9021", "9023", "9025"].includes(dataIdentifier)) {
      throw new Error(`数据标识错误：暂不支持 ${dataIdentifier || "未知"}。`);
    }
    const frameLength = uint(safeSlice(bytes, controlOffset + 1, 2), options.intEndian === "le" ? "le" : "be");
    const actualLength = bytes.length - start;
    if (frameLength !== actualLength) {
      throw new Error(`长度字段错误：声明 ${frameLength} Bytes，实际帧长 ${actualLength} Bytes。`);
    }
  },
  /** 解析大口径水表公共帧头，再分派到具体 DI 解析函数。 */
  parse(bytes, options = {}) {
    const start = findFrameStart(bytes);
    if (start < 0) throw new Error("不是有效的沃特曼报文：缺少起始符 68。");
    // 公共帧头：68 + 类型 1B + 地址 7B + 控制码。
    const controlOffset = start + 9;
    const diOffset = controlOffset + 3;
    const dataIdentifier = hex(safeSlice(bytes, diOffset, 2)).replace(" ", "");
    if (!["9021", "9023", "9025"].includes(dataIdentifier)) {
      throw new Error(`暂不支持沃特曼数据标识 ${dataIdentifier || "未知"}。`);
    }
    // 大口径帧在控制码后依次放置长度 2B 和 DI 2B。
    const index = controlOffset + 5;
    const values = dataIdentifier === "9025"
      ? parse9025(bytes, index, options)
      : parse902x(bytes, index, dataIdentifier as "9021" | "9023", options);
    const frameLength = uint(safeSlice(bytes, controlOffset + 1, 2), options.intEndian === "le" ? "le" : "be");
    const baseFields = [
      field(bytes, start, 1, "帧起始符", "68", { tone: "header" }),
      field(bytes, start + 1, 1, "仪表类型", "大口径水表", { tone: "meta" }),
      field(bytes, start + 2, 7, "表地址", meterAddress(bytes, start), { note: "低字节在前", tone: "meta" }),
      field(bytes, controlOffset, 1, "控制码", hexByte(bytes[controlOffset] ?? 0), { tone: "header" }),
      field(bytes, controlOffset + 1, 2, "本帧长度", `${frameLength} Bytes`, { tone: "meta" }),
      field(bytes, diOffset, 2, "数据标识 DI", dataIdentifier, { tone: "meta" }),
    ];
    // 合并通用帧检查、具体 DI 检查以及业务告警。
    const diagnostics = [...checksumDiagnostics(bytes, start), ...values.diagnostics];
    if (frameLength && frameLength > bytes.length) diagnostics.push({ level: "warn", text: "声明的帧长度大于实际收到的字节数。" });
    if (values.warnings.length) diagnostics.push({ level: "warn", text: `设备告警：${values.warnings.join("、")}。` });
    else diagnostics.push({ level: "ok", text: "设备未上报业务告警。" });

    return {
      protocol: `${this.name} · ${dataIdentifier}`,
      protocolId: this.id,
      category: "water",
      categoryLabel: "水表协议",
      manufacturer: "武汉沃特曼计量科技",
      confidence: this.detect(bytes),
      meterNo: meterAddress(bytes, start),
      controlCode: hexByte(bytes[controlOffset] ?? 0),
      dataIdentifier,
      dataLength: frameLength,
      coreValue: values.forwardFlow === null ? "无法识别" : `${formatNumber(values.forwardFlow, 3)} m³`,
      metrics: {
        forwardFlow: values.forwardFlow,
        reverseFlow: values.reverseFlow,
        instantFlow: values.instantFlow,
        pressure: values.pressure,
        temperature: values.temperature,
        meterVoltage: values.meterVoltage,
        collectorVoltage: values.collectorVoltage,
        csq: values.csq,
        imei: values.imei,
        imsi: values.imsi,
        collectTime: values.collectTime,
        valveStatus: values.valveStatus,
        statusInfo: values.statusInfo,
        hardwareVersion: values.hardwareVersion,
        softwareVersion: values.softwareVersion,
      },
      fields: [...baseFields, ...values.fields],
      diagnostics,
      history: values.history,
      rawBytes: bytes,
    };
  },
};
