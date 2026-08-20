import type { Diagnostic, ParsedField } from "./types";

/**
 * 将用户输入清洗成字节数组。
 * 同时支持连续 HEX、两位一组 HEX、0x 前缀，以及空格/换行/逗号等分隔符。
 */
export function parseHex(input: string): number[] {
  const compact = input
    .replace(/0x/gi, "")
    .replace(/[，,;；:_\-\s]+/g, "");
  if (!compact) return [];
  const invalid = compact.match(/[^0-9a-fA-F]/);
  if (invalid) {
    throw new Error(`HEX 报文包含非法字符“${invalid[0]}”。`);
  }
  if (compact.length % 2 !== 0) {
    throw new Error(`HEX 字符数量为奇数（${compact.length}），末尾缺少半个字节。`);
  }
  return compact.match(/.{2}/g)?.map((token) => Number.parseInt(token, 16)) ?? [];
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

/**
 * 严格检查通用 68 帧的前导字节、结束符和累加和。
 * 与结果页的 diagnostics 不同，这里用于阻止错误报文进入业务解析。
 */
export function validateFrameEnvelope(bytes: number[], start: number): void {
  if (start < 0) throw new Error("帧结构错误：未找到起始符 68。");
  if (bytes.slice(0, start).some((value) => value !== 0xfe)) {
    throw new Error("帧结构错误：起始符 68 前只能包含唤醒字节 FE。");
  }
  if (bytes.length - start < 14) throw new Error("帧长度不足：报文尚未接收完整。");
  if (bytes.at(-1) !== 0x16) throw new Error("帧结构错误：最后一个字节必须是结束符 16。");

  const checksumOffset = bytes.length - 2;
  const expected = bytes[checksumOffset];
  const calculated = bytes.slice(start, checksumOffset).reduce((sum, value) => (sum + value) & 0xff, 0);
  if (expected !== calculated) {
    throw new Error(`校验和错误：帧内 CS 为 ${hexByte(expected)}，正确值应为 ${hexByte(calculated)}。`);
  }
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
  // 5 字节通常省略世纪，6 字节则已经包含完整四位年份。
  if (!/^\d{10}(\d{2})?$/.test(digits)) return "—";
  const full = digits.length === 12 ? digits : `${century}${digits}`;
  return `${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)} ${full.slice(8, 10)}:${full.slice(10, 12)}`;
}

/** 安全截取字节；不足指定长度时返回空数组，避免解析器越界。 */
export function safeSlice(bytes: number[], offset: number, length: number): number[] {
  if (offset < 0 || offset + length > bytes.length) return [];
  return bytes.slice(offset, offset + length);
}
