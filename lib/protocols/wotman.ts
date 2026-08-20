import {
  bcdLittleEndian,
  checksumDiagnostics,
  field,
  findFrameStart,
  float32,
  formatNumber,
  hex,
  hexByte,
  meterAddress,
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
  // 沃特曼类型 1 的整数按低字节在前传输。
  if (type === "1") return uint(valueBytes, "le") / 10 ** decimals;
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

/** 把 BCD 字节原样拼为字符串，避免 IMEI/IMSI 超过 JavaScript 安全整数范围。 */
function bcdText(bytes: number[]): string {
  if (!bytes.length || bytes.some((value) => (value & 0x0f) > 9 || (value >> 4) > 9)) return "—";
  return bytes.map(hexByte).join("");
}

/** 解析 5 字节历史起始时间：分、时、日、月、年。 */
function parseHistoryTime(bytes: number[], century = "20"): string {
  if (bytes.length !== 5 || bytes.some((value) => (value & 0x0f) > 9 || (value >> 4) > 9)) return "—";
  const [minute, hour, day, month, year] = bytes.map(hexByte);
  return `${century}${year}-${month}-${day} ${hour}:${minute}`;
}

/** 解析 7 字节设备实时时间：秒、分、时、日、月、年、世纪。 */
function parseRealtime(bytes: number[]): string {
  if (bytes.length !== 7 || bytes.some((value) => (value & 0x0f) > 9 || (value >> 4) > 9)) return "—";
  const [second, minute, hour, day, month, year, century] = bytes.map(hexByte);
  return `${century}${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/** 读取 2 字节小端有符号整数，网络指标允许出现负值。 */
function signedInt16Little(bytes: number[]): number | null {
  if (bytes.length !== 2) return null;
  const unsigned = bytes[0] | (bytes[1] << 8);
  return unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
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
  totalFrames: number;
  frameIndex: number;
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
  rsrp: number | null;
  rsrq: number | null;
  snr: number | null;
  ecl: number | null;
  pci: string;
  imei: string;
  imsi: string;
  successCount: number;
  failureCount: number;
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
    totalFrames: 0,
    frameIndex: 0,
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
    rsrp: null,
    rsrq: null,
    snr: null,
    ecl: null,
    pci: "—",
    imei: "—",
    imsi: "—",
    successCount: 0,
    failureCount: 0,
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
  result.totalFrames = uint(safeSlice(bytes, index + 1, 2), "le");
  result.frameIndex = uint(safeSlice(bytes, index + 3, 2), "le");
  // 固定头之后依次为：条数 1B、首条时间 5B、间隔 1B、A-F 类型 3B。
  const countOffset = index + 5;
  const dataNumber = bytes[countOffset] ?? 0;
  result.dataNumber = dataNumber;
  const firstTimeOffset = index + 6;
  const firstTime = parseHistoryTime(safeSlice(bytes, firstTimeOffset, 5), options.century ?? "20");
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
  const forwardOffset = cursor;
  result.forwardFlow = typedValue(aType, safeSlice(bytes, cursor, 5), aType === "1" ? 0 : 2, floatEndian); cursor += 5;
  const reverseOffset = cursor;
  result.reverseFlow = typedValue(bType, safeSlice(bytes, cursor, 4), bType === "1" ? 0 : 2, floatEndian); cursor += 4;
  const instantOffset = cursor;
  result.instantFlow = typedValue(cType, safeSlice(bytes, cursor, 4), 3, floatEndian); cursor += 4;
  const pressureOffset = cursor;
  result.pressure = typedValue(dType, safeSlice(bytes, cursor, 4), 3, floatEndian); cursor += 4;
  const temperatureOffset = cursor;
  result.temperature = typedValue(eType, safeSlice(bytes, cursor, 4), 3, floatEndian); cursor += 4;
  const meterVoltageOffset = cursor;
  result.meterVoltage = typedValue(fType, safeSlice(bytes, cursor, 4), 3, floatEndian); cursor += 4;
  const collectorVoltageOffset = cursor;
  result.collectorVoltage = bcdLittleEndian(safeSlice(bytes, cursor, 2), 2); cursor += 2;
  const networkOffset = cursor;
  result.csq = bcdLittleEndian(safeSlice(bytes, cursor, 1), 0); cursor += 1;
  result.rsrp = signedInt16Little(safeSlice(bytes, cursor, 2)); cursor += 2;
  result.rsrq = signedInt16Little(safeSlice(bytes, cursor, 2)); cursor += 2;
  result.snr = signedInt16Little(safeSlice(bytes, cursor, 2)); cursor += 2;
  result.ecl = bytes[cursor] ?? null; cursor += 1;
  result.pci = bcdText(safeSlice(bytes, cursor, 2)); cursor += 2;
  const imeiOffset = cursor;
  result.imei = bcdText(safeSlice(bytes, cursor, 8)); cursor += 8;
  const imsiOffset = cursor;
  result.imsi = bcdText(safeSlice(bytes, cursor, 8)); cursor += 8;
  const countersOffset = cursor;
  result.successCount = uint(safeSlice(bytes, cursor, 2), "le"); cursor += 2;
  result.failureCount = uint(safeSlice(bytes, cursor, 2), "le"); cursor += 2;
  const realtimeOffset = cursor;
  result.collectTime = parseRealtime(safeSlice(bytes, cursor, 7)); cursor += 7;
  // 状态字为 2 字节低位在前；当前已明确的低位用于阀门和电池状态。
  const statusOffset = cursor;
  const status = uint(safeSlice(bytes, cursor, 2), "le"); cursor += 2;
  result.valveStatus = (status & 0x01) === 1 ? "关闭" : "开启";
  const statusLabels = [(status & 0x02) ? "阀门故障" : "", (status & 0x04) ? "电池欠压" : ""].filter(Boolean);
  result.statusInfo = statusLabels.join("、") || "正常";
  const warningOffset = cursor;
  const warningBytes = safeSlice(bytes, cursor, 3); cursor += 3;
  result.warnings = warningLabels(warningBytes);
  const versionOffset = cursor;
  result.hardwareVersion = formatNumber(bcdLittleEndian(safeSlice(bytes, cursor, 2), 2), 2); cursor += 2;
  result.softwareVersion = formatNumber(bcdLittleEndian(safeSlice(bytes, cursor, 2), 2), 2);

  // 记录全部连续业务区域，字段表和字节地图不会留下无归属的 DATA 字节。
  result.fields.push(
    field(bytes, index, 1, "流水号 SER", String(bytes[index] ?? 0), { tone: "meta" }),
    field(bytes, index + 1, 2, "总帧数", String(result.totalFrames), { note: "无符号整数，小端", tone: "meta" }),
    field(bytes, index + 3, 2, "当前帧序号", String(result.frameIndex), { note: "无符号整数，小端", tone: "meta" }),
    field(bytes, countOffset, 1, "历史数据条数", String(dataNumber), { tone: "meta" }),
    field(bytes, firstTimeOffset, 5, "首条采集时间", firstTime, { note: "分、时、日、月、年，BCD", tone: "meta" }),
    field(bytes, index + 11, 1, "采集间隔", String(intervalMinutes), { unit: "分钟", tone: "meta" }),
    field(bytes, typeOffset, 3, "A-F 数据类型", typeHex, { note: "1=整数，2=BCD，3=Float", tone: "meta" }),
    field(bytes, recordOffset, dataNumber * 17, "历史数据区", `${result.history.length} 条`, { note: "每条 17 字节", tone: "value" }),
    field(bytes, forwardOffset, 5, "当前正向累计流量 A", formatNumber(result.forwardFlow, 3), { unit: "m³", note: `类型 ${aType}`, tone: "value" }),
    field(bytes, reverseOffset, 4, "当前反向累计流量 B", formatNumber(result.reverseFlow, 3), { unit: "m³", note: `类型 ${bType}`, tone: "value" }),
    field(bytes, instantOffset, 4, "当前瞬时流量 C", formatNumber(result.instantFlow, 3), { unit: "m³/h", note: `类型 ${cType}`, tone: "value" }),
    field(bytes, pressureOffset, 4, "当前压力 D", formatNumber(result.pressure, 3), { unit: "MPa", note: `类型 ${dType}`, tone: "value" }),
    field(bytes, temperatureOffset, 4, "当前温度 E", formatNumber(result.temperature, 3), { unit: "℃", note: `类型 ${eType}`, tone: "value" }),
    field(bytes, meterVoltageOffset, 4, "水表电池电压 F", formatNumber(result.meterVoltage, 3), { unit: "V", note: `类型 ${fType}`, tone: "status" }),
    field(bytes, collectorVoltageOffset, 2, "采集器电压", formatNumber(result.collectorVoltage, 2), { unit: "V", note: "BCD，小端", tone: "status" }),
    field(bytes, networkOffset, 10, "蜂窝网络指标", `CSQ ${result.csq} / RSRP ${result.rsrp} / RSRQ ${result.rsrq} / SNR ${result.snr}`, { note: `含 ECL ${result.ecl}、PCI ${result.pci}`, tone: "status" }),
    field(bytes, imeiOffset, 8, "IMEI", result.imei, { note: "BCD，保持字节顺序", tone: "meta" }),
    field(bytes, imsiOffset, 8, "IMSI", result.imsi, { note: "BCD，保持字节顺序", tone: "meta" }),
    field(bytes, countersOffset, 2, "通信成功次数", String(result.successCount), { note: "无符号整数，小端", tone: "meta" }),
    field(bytes, countersOffset + 2, 2, "通信失败次数", String(result.failureCount), { note: "无符号整数，小端", tone: "meta" }),
    field(bytes, realtimeOffset, 7, "设备实时时间", result.collectTime, { note: "秒、分、时、日、月、年、世纪，BCD", tone: "meta" }),
    field(bytes, statusOffset, 2, "仪表状态", `${result.valveStatus} / ${result.statusInfo}`, { note: "2 字节位图，小端", tone: "status" }),
    field(bytes, warningOffset, 3, "告警信息", result.warnings.join("、") || "无告警", { tone: "status" }),
    field(bytes, versionOffset, 2, "硬件版本", result.hardwareVersion, { note: "BCD，小端", tone: "meta" }),
    field(bytes, versionOffset + 2, 2, "软件版本", result.softwareVersion, { note: "BCD，小端", tone: "meta" }),
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
  result.totalFrames = uint(safeSlice(bytes, index + 1, 2), "le");
  result.frameIndex = uint(safeSlice(bytes, index + 3, 2), "le");
  const valueLength = di === "9021" ? 4 : 5;
  const dataNumber = bytes[index + 5] ?? 0;
  result.dataNumber = dataNumber;
  const firstTime = parseHistoryTime(safeSlice(bytes, index + 6, 5), options.century ?? "20");
  const intervalMinutes = bytes[index + 11] ?? 0;
  const historyOffset = index + 12;
  const firstTimeMs = firstTime === "—" ? Number.NaN : new Date(firstTime.replace(" ", "T")).getTime();
  // 历史区只记录累计流量，采集时间由首条时间和间隔推算。
  for (let i = 0; i < dataNumber; i += 1) {
    const raw = safeSlice(bytes, historyOffset + i * valueLength, valueLength);
    if (raw.length !== valueLength) break;
    const parsed = bcdLittleEndian(raw, di === "9023" ? 4 : 2);
    result.history.push({
      collectTime: Number.isFinite(firstTimeMs)
        ? new Date(firstTimeMs + intervalMinutes * 60_000 * i).toLocaleString("zh-CN", { hour12: false })
        : firstTime,
      forwardFlow: parsed ?? undefined,
    });
  }
  // 当前累计量之后按照 Java 源码顺序读取瞬时量和通信模块信息。
  let cursor = historyOffset + dataNumber * valueLength;
  const currentOffset = cursor;
  const currentRaw = safeSlice(bytes, cursor, valueLength);
  const current = bcdLittleEndian(currentRaw, di === "9023" ? 4 : 2);
  result.forwardFlow = current; cursor += valueLength;
  // 瞬时流量为 2 字节小端无符号整数，固定保留 2 位小数。
  const instantOffset = cursor;
  result.instantFlow = uint(safeSlice(bytes, cursor, 2), "le") / 100; cursor += 2;
  // 9021 后续保留 4 字节；9023 后续为传感器 A/B 与保留字段，共 5 字节。
  const sensorOffset = cursor;
  cursor += valueLength;
  const meterVoltageOffset = cursor;
  result.meterVoltage = bcdLittleEndian(safeSlice(bytes, cursor, 2), 2); cursor += 2;
  const networkOffset = cursor;
  result.csq = bcdLittleEndian(safeSlice(bytes, cursor, 1), 0); cursor += 1;
  result.rsrp = signedInt16Little(safeSlice(bytes, cursor, 2)); cursor += 2;
  result.rsrq = signedInt16Little(safeSlice(bytes, cursor, 2)); cursor += 2;
  result.snr = signedInt16Little(safeSlice(bytes, cursor, 2)); cursor += 2;
  result.ecl = bytes[cursor] ?? null; cursor += 1;
  result.pci = bcdText(safeSlice(bytes, cursor, 2)); cursor += 2;
  const imeiOffset = cursor;
  result.imei = bcdText(safeSlice(bytes, cursor, 8)); cursor += 8;
  const imsiOffset = cursor;
  result.imsi = bcdText(safeSlice(bytes, cursor, 8)); cursor += 8;
  const countersOffset = cursor;
  result.successCount = uint(safeSlice(bytes, cursor, 2), "le"); cursor += 2;
  result.failureCount = uint(safeSlice(bytes, cursor, 2), "le"); cursor += 2;
  const realtimeOffset = cursor;
  result.collectTime = parseRealtime(safeSlice(bytes, cursor, 7)); cursor += 7;
  const statusOffset = cursor;
  const status = uint(safeSlice(bytes, cursor, 2), "le"); cursor += 2;
  result.valveStatus = (status & 0x01) === 1 ? "关闭" : "开启";
  result.statusInfo = [(status & 0x02) ? "阀门故障" : "", (status & 0x04) ? "电池欠压" : ""].filter(Boolean).join("、") || "正常";
  const warningOffset = cursor;
  const warningBytes = safeSlice(bytes, cursor, 3); cursor += 3;
  result.warnings = warningLabels(warningBytes);
  const versionOffset = cursor;
  result.hardwareVersion = formatNumber(bcdLittleEndian(safeSlice(bytes, cursor, 2), 2), 2); cursor += 2;
  result.softwareVersion = formatNumber(bcdLittleEndian(safeSlice(bytes, cursor, 2), 2), 2);
  result.fields.push(
    field(bytes, index, 1, "流水号 SER", String(bytes[index] ?? 0), { tone: "meta" }),
    field(bytes, index + 1, 2, "总帧数", String(result.totalFrames), { note: "无符号整数，小端", tone: "meta" }),
    field(bytes, index + 3, 2, "当前帧序号", String(result.frameIndex), { note: "无符号整数，小端", tone: "meta" }),
    field(bytes, index + 5, 1, "历史数据条数", String(dataNumber), { tone: "meta" }),
    field(bytes, index + 6, 5, "首条采集时间", firstTime, { note: "分、时、日、月、年，BCD", tone: "meta" }),
    field(bytes, index + 11, 1, "采集间隔", String(intervalMinutes), { unit: "分钟", tone: "meta" }),
    field(bytes, historyOffset, dataNumber * valueLength, "历史累计流量", `${result.history.length} 条`, { tone: "value" }),
    field(bytes, currentOffset, valueLength, "当前累计流量", formatNumber(result.forwardFlow, 4), { unit: "m³", note: `BCD，小端，${di === "9023" ? 4 : 2} 位小数`, tone: "value" }),
    field(bytes, instantOffset, 2, "瞬时流量", formatNumber(result.instantFlow, 2), { unit: "m³/h", note: "无符号整数，小端，2 位小数", tone: "value" }),
    field(bytes, sensorOffset, valueLength, di === "9023" ? "传感器数据与保留字" : "保留字段", hex(safeSlice(bytes, sensorOffset, valueLength)), { tone: "meta" }),
    field(bytes, meterVoltageOffset, 2, "水表电池电压", formatNumber(result.meterVoltage, 2), { unit: "V", note: "BCD，小端", tone: "status" }),
    field(bytes, networkOffset, 10, "蜂窝网络指标", `CSQ ${result.csq} / RSRP ${result.rsrp} / RSRQ ${result.rsrq} / SNR ${result.snr}`, { note: `含 ECL ${result.ecl}、PCI ${result.pci}`, tone: "status" }),
    field(bytes, imeiOffset, 8, "IMEI", result.imei, { note: "BCD，保持字节顺序", tone: "meta" }),
    field(bytes, imsiOffset, 8, "IMSI", result.imsi, { note: "BCD，保持字节顺序", tone: "meta" }),
    field(bytes, countersOffset, 2, "通信成功次数", String(result.successCount), { note: "无符号整数，小端", tone: "meta" }),
    field(bytes, countersOffset + 2, 2, "通信失败次数", String(result.failureCount), { note: "无符号整数，小端", tone: "meta" }),
    field(bytes, realtimeOffset, 7, "设备实时时间", result.collectTime, { note: "秒、分、时、日、月、年、世纪，BCD", tone: "meta" }),
    field(bytes, statusOffset, 2, "仪表状态", `${result.valveStatus} / ${result.statusInfo}`, { note: "2 字节位图，小端", tone: "status" }),
    field(bytes, warningOffset, 3, "告警信息", result.warnings.join("、") || "无告警", { tone: "status" }),
    field(bytes, versionOffset, 2, "硬件版本", result.hardwareVersion, { note: "BCD，小端", tone: "meta" }),
    field(bytes, versionOffset + 2, 2, "软件版本", result.softwareVersion, { note: "BCD，小端", tone: "meta" }),
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
    if (start < 0 || bytes.length < start + 14) return 0;
    const controlOffset = start + 9;
    const declaredDataLength = uint(safeSlice(bytes, controlOffset + 1, 2), "le");
    // 大口径帧从 68 起共 L + 14 字节，L 为 2 字节小端 DATA 长度。
    if (bytes.length - start !== declaredDataLength + 14) return 5;
    const di = hex(safeSlice(bytes, controlOffset + 3, 2)).replace(" ", "");
    let score = 55;
    if (["9021", "9023", "9025"].includes(di)) score += 20;
    if (getWaterMeterType(bytes[start + 1])) score += 5;
    if ([0x01, 0x41, 0x81, 0x04, 0x84].includes(bytes[controlOffset])) score += 10;
    if (bytes.at(-1) === 0x16) score += 5;
    const calculated = bytes.slice(start, -2).reduce((sum, value) => (sum + value) & 0xff, 0);
    if (bytes.at(-2) === calculated) score += 5;
    return Math.min(score, 100);
  },
  /** 校验沃特曼公共帧头、总长度和已接入的数据标识。 */
  validate(bytes) {
    const start = findFrameStart(bytes);
    validateFrameEnvelope(bytes, start);
    if (!getWaterMeterType(bytes[start + 1])) {
      throw new Error(`仪表类型错误：${hexByte(bytes[start + 1] ?? 0)}H 不属于水表类型 10H–19H。`);
    }
    const controlOffset = start + 9;
    if (![0x01, 0x41, 0x81, 0x04, 0x84].includes(bytes[controlOffset])) {
      throw new Error(`控制码错误：暂不支持 ${hexByte(bytes[controlOffset] ?? 0)}H。`);
    }
    const dataIdentifier = hex(safeSlice(bytes, controlOffset + 3, 2)).replace(" ", "");
    if (!["9021", "9023", "9025"].includes(dataIdentifier)) {
      throw new Error(`数据标识错误：暂不支持 ${dataIdentifier || "未知"}。`);
    }
    const declaredDataLength = uint(safeSlice(bytes, controlOffset + 1, 2), "le");
    const actualDataLength = bytes.length - start - 14;
    if (declaredDataLength !== actualDataLength) {
      throw new Error(`长度字段错误：大口径帧声明 DATA 为 ${declaredDataLength} Bytes，实际为 ${actualDataLength} Bytes。`);
    }
    if (declaredDataLength < 8) throw new Error("数据区错误：沃特曼 DATA 缺少分帧头或历史条数。");
    const dataOffset = start + 12;
    const count = bytes[dataOffset + 7] ?? 0;
    const minimumLength = dataIdentifier === "9021"
      ? 72 + count * 4
      : dataIdentifier === "9023"
        ? 74 + count * 5
        : 90 + count * 17;
    if (declaredDataLength < minimumLength) {
      throw new Error(`数据区不完整：${dataIdentifier} 声明 ${count} 条历史数据时至少需要 ${minimumLength} Bytes，当前为 ${declaredDataLength} Bytes。`);
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
    const dataLength = uint(safeSlice(bytes, controlOffset + 1, 2), "le");
    const checksumOffset = start + 12 + dataLength;
    const meterType = getWaterMeterType(bytes[start + 1]);
    const baseFields = [
      ...(start > 0 ? [field(bytes, 0, start, "唤醒字节", `${start} 个 FE`, { note: "不参与 CS 计算", tone: "meta" })] : []),
      field(bytes, start, 1, "帧起始符", "68", { tone: "header" }),
      field(bytes, start + 1, 1, "仪表类型", meterType?.label ?? "大口径水表", { note: meterType?.codeLabel, tone: "meta" }),
      field(bytes, start + 2, 7, "表地址", meterAddress(bytes, start), { note: "低字节在前", tone: "meta" }),
      field(bytes, controlOffset, 1, "控制码", hexByte(bytes[controlOffset] ?? 0), { tone: "header" }),
      field(bytes, controlOffset + 1, 2, "数据长度 L", `${dataLength} Bytes`, { note: "2 字节无符号整数，小端；仅表示 DATA 长度", tone: "meta" }),
      field(bytes, diOffset, 2, "数据标识 DI", dataIdentifier, { tone: "meta" }),
    ];
    // 合并通用帧检查、具体 DI 检查以及业务告警。
    const diagnostics = [...checksumDiagnostics(bytes, start), ...values.diagnostics];
    if (values.warnings.length) diagnostics.push({ level: "warn", text: `设备告警：${values.warnings.join("、")}。` });
    else diagnostics.push({ level: "ok", text: "设备未上报业务告警。" });
    const endingFields = [
      field(bytes, checksumOffset, 1, "校验和 CS", hexByte(bytes[checksumOffset]), { note: "从 68 至 DATA 末字节累加取低 8 位", tone: "check" }),
      field(bytes, checksumOffset + 1, 1, "结束符", "16H", { tone: "header" }),
    ];

    const overviewSections: ParseResult["overviewSections"] = [
      { id: "meter", title: "仪表与报文", items: [
        { key: "meterType", label: "仪表类型", value: meterType ? `${meterType.label} · ${meterType.codeLabel}` : "大口径水表" },
        { key: "meterNo", label: "表号", value: meterAddress(bytes, start) },
        { key: "dataIdentifier", label: "数据标识", value: dataIdentifier },
        { key: "frames", label: "分帧位置", value: `${values.frameIndex} / ${values.totalFrames}` },
      ] },
      { id: "measurement", title: "计量数据", items: [
        { key: "forwardFlow", label: "正向累计流量", value: values.forwardFlow, unit: "m³" },
        { key: "reverseFlow", label: "反向累计流量", value: values.reverseFlow, unit: "m³" },
        { key: "instantFlow", label: "瞬时流量", value: values.instantFlow, unit: "m³/h" },
        { key: "pressure", label: "压力", value: values.pressure, unit: "MPa" },
        { key: "temperature", label: "温度", value: values.temperature, unit: "℃" },
        { key: "collectTime", label: "设备时间", value: values.collectTime },
      ] },
      { id: "network", title: "设备与网络状态", items: [
        { key: "valveStatus", label: "阀门状态", value: values.valveStatus },
        { key: "statusInfo", label: "设备状态", value: values.statusInfo },
        { key: "csq", label: "CSQ", value: values.csq },
        { key: "rsrp", label: "RSRP", value: values.rsrp },
        { key: "rsrq", label: "RSRQ", value: values.rsrq },
        { key: "snr", label: "SNR", value: values.snr },
        { key: "ecl", label: "ECL", value: values.ecl },
        { key: "pci", label: "PCI", value: values.pci },
        { key: "imei", label: "IMEI", value: values.imei },
        { key: "imsi", label: "IMSI", value: values.imsi },
      ] },
    ];

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
      dataLength,
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
        rsrp: values.rsrp,
        rsrq: values.rsrq,
        snr: values.snr,
        ecl: values.ecl,
        pci: values.pci,
        imei: values.imei,
        imsi: values.imsi,
        collectTime: values.collectTime,
        valveStatus: values.valveStatus,
        statusInfo: values.statusInfo,
        hardwareVersion: values.hardwareVersion,
        softwareVersion: values.softwareVersion,
        successCount: values.successCount,
        failureCount: values.failureCount,
      },
      overviewSections,
      fields: [...baseFields, ...values.fields, ...endingFields],
      diagnostics,
      history: values.history,
      rawBytes: bytes,
    };
  },
};
