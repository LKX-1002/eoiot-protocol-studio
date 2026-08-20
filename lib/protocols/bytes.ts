import type { Diagnostic, ParsedField } from "./types";

/** 将用户输入清洗成字节数组，并拒绝不完整或非法的 HEX 字节。 */
export function parseHex(input: string): number[] {
  const normalized = input
    .replace(/0x/gi, "")
    .replace(/[，,;；\s]+/g, " ")
    .trim();
  if (!normalized) return [];
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.some((token) => !/^[0-9a-fA-F]{2}$/.test(token))) {
    throw new Error("HEX 报文中存在非两位十六进制字节。");
  }
  return tokens.map((token) => Number.parseInt(token, 16));
}

/** 把单字节格式化为两位大写 HEX。 */
export function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

/** 把字节数组格式化为适合展示和复制的 HEX 字符串。 */
export function hex(bytes: number[]): string {
  return bytes.map(hexByte).join(" ");
}

/** 创建标准字段对象，并自动限制越界长度。 */
export function field(
  bytes: number[],
  offset: number,
  length: number,
  name: string,
  value: string,
  options: Pick<ParsedField, "unit" | "note" | "tone"> = {},
): ParsedField {
  const safeOffset = Math.max(0, offset);
  const safeLength = Math.max(0, Math.min(length, bytes.length - safeOffset));
  return {
    offset: safeOffset,
    length: safeLength,
    name,
    raw: hex(bytes.slice(safeOffset, safeOffset + safeLength)),
    value,
    ...options,
  };
}

/** 查找协议帧起始符；前导 FE 唤醒字节会被自然跳过。 */
export function findFrameStart(bytes: number[]): number {
  return bytes.findIndex((value) => value === 0x68);
}

/** 按指定端序读取无符号整数，支持超过 4 字节的数据。 */
export function uint(bytes: number[], endian: "be" | "le" = "be"): number {
  const source = endian === "le" ? [...bytes].reverse() : bytes;
  return source.reduce((total, value) => total * 256 + value, 0);
}

/** 解析低字节在前的 BCD 数据。 */
export function bcdLittleEndian(bytes: number[], decimals = 0): number | null {
  const digits = [...bytes]
    .reverse()
    .map((value) => hexByte(value))
    .join("");
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits) / 10 ** decimals;
}

/** 解析保持原顺序的 BCD 数据，主要用于 IMEI、IMSI。 */
export function bcdInOrder(bytes: number[], decimals = 0): number | null {
  const digits = bytes.map((value) => hexByte(value)).join("");
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits) / 10 ** decimals;
}

/** 使用 DataView 解析 IEEE 754 单精度浮点数。 */
export function float32(bytes: number[], endian: "be" | "le" = "be"): number | null {
  if (bytes.length < 4) return null;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  bytes.slice(0, 4).forEach((value, index) => view.setUint8(index, value));
  const value = view.getFloat32(0, endian === "le");
  return Number.isFinite(value) ? value : null;
}

/** 统一业务数字的中文显示格式。 */
export function formatNumber(value: number | null, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

/** CJ/T 188 地址字段为低字节在前，展示时需要反转。 */
export function meterAddress(bytes: number[], start: number): string {
  const address = bytes.slice(start + 2, start + 9);
  const reversed = [...address].reverse().map(hexByte).join("");
  return reversed.replace(/^0+/, "") || "0";
}

/**
 * 检查 68/16 边界与累加和 CS。
 * CS 为从 68 开始到 CS 前一字节的低 8 位累加和。
 */
export function checksumDiagnostics(bytes: number[], start: number): Diagnostic[] {
  const result: Diagnostic[] = [];
  const end = bytes.lastIndexOf(0x16);
  if (start < 0) return [{ level: "bad", text: "未找到帧起始符 68。" }];
  if (end < 0) {
    result.push({ level: "bad", text: "未找到结束符 16。" });
    return result;
  }
  result.push({ level: "ok", text: "帧起始符与结束符有效。" });
  if (end > start + 1) {
    const expected = bytes[end - 1];
    const calculated = bytes.slice(start, end - 1).reduce((sum, value) => (sum + value) & 0xff, 0);
    result.push(
      expected === calculated
        ? { level: "ok", text: `CS 校验正确（${hexByte(expected)}）。` }
        : { level: "warn", text: `CS 校验不一致：帧内 ${hexByte(expected)}，计算值 ${hexByte(calculated)}。` },
    );
  }
  return result;
}

/** 把倒序 BCD 时间转为界面可读格式。 */
export function parseReverseBcdTime(bytes: number[], century = "20"): string {
  const digits = [...bytes].reverse().map(hexByte).join("");
  if (!/^\d{10}$/.test(digits)) return "—";
  const full = `${century}${digits}`;
  return `${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)} ${full.slice(8, 10)}:${full.slice(10, 12)}`;
}

/** 安全截取字节；不足指定长度时返回空数组，避免解析器越界。 */
export function safeSlice(bytes: number[], offset: number, length: number): number[] {
  if (offset < 0 || offset + length > bytes.length) return [];
  return bytes.slice(offset, offset + length);
}
