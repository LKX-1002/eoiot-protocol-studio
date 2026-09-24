import { bcdLittleEndian, field, findFrameStart, formatNumber, hex, hexByte, parseHex, safeSlice, uint, validateFrameEnvelope } from "./bytes";
import type { ParsedField } from "./types";

export interface WotmanSyncCommandInput {
  meterAddress: string;
  cumulativeFlow: string;
}

export interface WotmanSyncCommandResult {
  bytes: number[];
  compactHex: string;
  spacedHex: string;
  checksum: string;
  fields: ParsedField[];
  meterAddress: string;
  cumulativeFlow: number;
  unitCode: string;
}

function encodeMeterAddress(value: string): number[] {
  const normalized = value.replace(/[\s-]/g, "");
  if (!/^\d{1,14}$/.test(normalized)) throw new Error("仪表地址必须为 1–14 位数字。");
  return normalized.padStart(14, "0").match(/.{2}/g)!.reverse().map((token) => Number.parseInt(token, 16));
}

/** 2CH 表示每个 BCD 计数为 0.01 m³；10 m³ 因此编码为 00 10 00 00。 */
function encodeFlow(value: string): number[] {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("累计流量必须是非负数，最多保留 2 位小数。");
  const scaled = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(scaled) || scaled > 99_999_999) throw new Error("累计流量超出 4 字节 BCD 可表示范围。");
  return scaled.toString().padStart(8, "0").match(/.{2}/g)!.reverse().map((token) => Number.parseInt(token, 16));
}

export function buildWotmanSyncCommand(input: WotmanSyncCommandInput): WotmanSyncCommandResult {
  const address = encodeMeterAddress(input.meterAddress);
  const flow = encodeFlow(input.cumulativeFlow);
  const bytes = [0x68, 0x10, ...address, 0x04, 0x08, 0x00, 0xa0, 0x16, 0x00, ...flow, 0x2c];
  const checksum = bytes.reduce((sum, value) => (sum + value) & 0xff, 0);
  bytes.push(checksum, 0x16);
  const cumulativeFlow = bcdLittleEndian(flow, 0)! * 0.01;
  const meterAddress = input.meterAddress.replace(/[\s-]/g, "").padStart(14, "0");
  const fields: ParsedField[] = [
    field(bytes, 0, 1, "起始符", "68H", { tone: "header" }),
    field(bytes, 1, 1, "仪表类型", "冷水水表 · 10H", { tone: "meta" }),
    field(bytes, 2, 7, "设备编号", meterAddress, { note: "7 字节 BCD，低字节在前", tone: "meta" }),
    field(bytes, 9, 1, "控制码", "04H", { note: "平台下发", tone: "header" }),
    field(bytes, 10, 2, "数据长度", "8 Bytes", { note: "从 DI 至单位字节", tone: "meta" }),
    field(bytes, 12, 2, "数据标识 DI", "A016H", { note: "写机电同步", tone: "meta" }),
    field(bytes, 14, 1, "序列号 SER", "0", { tone: "meta" }),
    field(bytes, 15, 4, "当前累计流量", formatNumber(cumulativeFlow, 2), { unit: "m³", note: "4 字节 BCD，小端", tone: "value" }),
    field(bytes, 19, 1, "计量单位", "m³", { note: "2CH：10 升/计数，即 0.01 m³", tone: "value" }),
    field(bytes, 20, 1, "校验码 CS", hexByte(checksum), { note: "从 68H 累加至单位字节", tone: "check" }),
    field(bytes, 21, 1, "结束符", "16H", { tone: "header" }),
  ];
  return { bytes, compactHex: bytes.map(hexByte).join(""), spacedHex: hex(bytes), checksum: hexByte(checksum), fields, meterAddress, cumulativeFlow, unitCode: "2C" };
}

export function parseWotmanSyncCommand(input: string | number[]): WotmanSyncCommandResult {
  const bytes = typeof input === "string" ? parseHex(input) : input;
  const start = findFrameStart(bytes);
  validateFrameEnvelope(bytes, start);
  if ((bytes[start + 1] & 0xf0) !== 0x10) throw new Error("仪表类型错误：写机电同步要求 1XH 水表类型。");
  if (bytes[start + 9] !== 0x04) throw new Error(`控制码错误：写机电同步必须为 04H，收到 ${hexByte(bytes[start + 9] ?? 0)}H。`);
  const length = uint(safeSlice(bytes, start + 10, 2), "le");
  if (length !== 8) throw new Error(`长度错误：A016H 数据区应为 8 Bytes，当前声明为 ${length} Bytes。`);
  if (bytes.length - start - 14 !== length) throw new Error(`长度错误：声明 ${length} Bytes，DI 至 CS 前实际为 ${bytes.length - start - 14} Bytes。`);
  if (bytes[start + 12] !== 0xa0 || bytes[start + 13] !== 0x16) throw new Error("数据标识错误：写机电同步必须为 A016H。");
  if (bytes[start + 19] !== 0x2c) throw new Error(`单位错误：当前仅支持 2CH（m³），收到 ${hexByte(bytes[start + 19] ?? 0)}H。`);
  const meterRaw = safeSlice(bytes, start + 2, 7);
  if (meterRaw.some((value) => (value & 0x0f) > 9 || (value >> 4) > 9)) throw new Error("设备编号不是有效的 7 字节 BCD。");
  const flowRaw = safeSlice(bytes, start + 15, 4);
  const rawValue = bcdLittleEndian(flowRaw, 0);
  if (rawValue === null) throw new Error("当前累计流量不是有效的 4 字节 BCD。");
  const meterAddress = [...meterRaw].reverse().map(hexByte).join("");
  const cumulativeFlow = rawValue * 0.01;
  const checksumOffset = start + 20;
  const fields: ParsedField[] = [
    ...(start > 0 ? [field(bytes, 0, start, "唤醒字节", `${start} 个 FE`, { note: "不参与 CS 计算", tone: "meta" })] : []),
    field(bytes, start, 1, "起始符", "68H", { tone: "header" }),
    field(bytes, start + 1, 1, "仪表类型", `${hexByte(bytes[start + 1])}H`, { tone: "meta" }),
    field(bytes, start + 2, 7, "设备编号", meterAddress, { note: "7 字节 BCD，低字节在前", tone: "meta" }),
    field(bytes, start + 9, 1, "控制码", "04H", { note: "平台下发", tone: "header" }),
    field(bytes, start + 10, 2, "数据长度", "8 Bytes", { note: "从 DI 至单位字节", tone: "meta" }),
    field(bytes, start + 12, 2, "数据标识 DI", "A016H", { note: "写机电同步", tone: "meta" }),
    field(bytes, start + 14, 1, "序列号 SER", String(bytes[start + 14]), { tone: "meta" }),
    field(bytes, start + 15, 4, "当前累计流量", formatNumber(cumulativeFlow, 2), { unit: "m³", note: "4 字节 BCD，小端", tone: "value" }),
    field(bytes, start + 19, 1, "计量单位", "m³", { note: "2CH：10 升/计数，即 0.01 m³", tone: "value" }),
    field(bytes, checksumOffset, 1, "校验码 CS", hexByte(bytes[checksumOffset]), { note: "从 68H 累加至单位字节", tone: "check" }),
    field(bytes, checksumOffset + 1, 1, "结束符", "16H", { tone: "header" }),
  ];
  return { bytes, compactHex: bytes.map(hexByte).join(""), spacedHex: hex(bytes), checksum: hexByte(bytes[checksumOffset]), fields, meterAddress, cumulativeFlow, unitCode: "2C" };
}
