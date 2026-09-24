import { field, findFrameStart, hex, hexByte, parseHex, safeSlice, uint, validateFrameEnvelope } from "./bytes";
import type { ParsedField } from "./types";

/** 沃特曼 04H / 8110H 写通信参数指令的可编辑参数。 */
export interface WotmanIpCommandInput {
  /** 14 位 BCD 仪表地址；不足 14 位时左侧补零，发送时低字节在前。 */
  meterAddress: string;
  primaryIp: string;
  primaryPort: string;
  /** APN 最多 16 个 ASCII 字节，剩余位置自动补 00H。 */
  apn: string;
}

/** 组帧结果同时服务复制区和字段说明表。 */
export interface WotmanIpCommandResult {
  bytes: number[];
  compactHex: string;
  spacedHex: string;
  checksum: string;
  fields: ParsedField[];
}

/** 8110H 写通信参数指令的反向解析结果。 */
export interface ParsedWotmanIpCommand extends WotmanIpCommandResult {
  meterAddress: string;
  primaryIp: string;
  primaryPort: number;
  backupIp: string;
  backupPort: number;
  gatewayIp: string;
  gatewayPort: number;
  proxyIp: string;
  proxyPort: number;
  apn: string;
  localIp: string;
  localPort: number;
  subnetMask: string;
  macAddress: string;
}

/** 将展示顺序的 14 位 BCD 表号转成协议要求的低字节在前格式。 */
function encodeMeterAddress(value: string): number[] {
  const normalized = value.replace(/[\s-]/g, "");
  if (!/^\d{1,14}$/.test(normalized)) throw new Error("仪表地址必须为 1–14 位数字。");
  const padded = normalized.padStart(14, "0");
  return padded.match(/.{2}/g)!.reverse().map((token) => Number.parseInt(token, 16));
}

/** IPv4 在协议中按阅读顺序逐字节写入，例如 221.131.181.7 → DD 83 B5 07。 */
function encodeIpv4(value: string): number[] {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error("主用 IP 必须是有效的 IPv4 地址，例如 60.205.218.69。");
  }
  return parts.map(Number);
}

/** 端口使用 2 字节无符号整数、小端传输，例如 9995 → 0B 27。 */
function encodePort(value: string): number[] {
  if (!/^\d+$/.test(value.trim())) throw new Error("主用端口必须为 1–65535 的整数。");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("主用端口必须为 1–65535 的整数。");
  return [port & 0xff, (port >> 8) & 0xff];
}

/** APN 固定占 16 字节；只接受单字节 ASCII，避免中文被错误截断。 */
function encodeApn(value: string): number[] {
  const normalized = value.trim();
  if (!normalized) throw new Error("APN 不能为空。");
  if (normalized.length > 16 || [...normalized].some((character) => character.charCodeAt(0) > 0x7f)) {
    throw new Error("APN 必须是 1–16 个 ASCII 字符。");
  }
  const result = new Array<number>(16).fill(0);
  [...normalized].forEach((character, index) => { result[index] = character.charCodeAt(0); });
  return result;
}

/**
 * 生成沃特曼下行通信参数帧。
 * 固定项：控制码 04H、长度 003BH、数据标识 8110H、序列号 00H。
 * 未开放的备用、网关、代理、本地网络与 MAC 字段按协议模板填 00H。
 */
export function buildWotmanIpCommand(input: WotmanIpCommandInput): WotmanIpCommandResult {
  const meterAddress = encodeMeterAddress(input.meterAddress);
  const primaryIp = encodeIpv4(input.primaryIp);
  const primaryPort = encodePort(input.primaryPort);
  const apn = encodeApn(input.apn);

  const bytes = [
    0x68, 0x10, ...meterAddress,
    0x04, 0x3b, 0x00,
    0x81, 0x10, 0x00,
    ...primaryIp, ...primaryPort,
    // 备用 IP/端口、网关地址/端口、代理服务器 IP/端口，各占 4 + 2 字节。
    ...new Array<number>(18).fill(0),
    ...apn,
    // 本地 IP/端口、子掩码、MAC 地址。
    ...new Array<number>(16).fill(0),
  ];

  // L=3BH 的边界是 DI(偏移 12) 至 MAC 末字节；不含 CS 与结束符。
  const dataLength = bytes.length - 12;
  if (dataLength !== 0x3b) throw new Error(`内部组帧长度错误：数据区应为 59 Bytes，当前为 ${dataLength} Bytes。`);

  // CS 为从 68H 开始至数据区最后一个字节的累加和低 8 位。
  const checksum = bytes.reduce((sum, value) => (sum + value) & 0xff, 0);
  bytes.push(checksum, 0x16);

  const fields: ParsedField[] = [
    field(bytes, 0, 1, "起始符", "68H", { tone: "header" }),
    field(bytes, 1, 1, "仪表类型", "冷水水表 · 10H", { tone: "meta" }),
    field(bytes, 2, 7, "仪表地址", input.meterAddress.replace(/[\s-]/g, "").padStart(14, "0"), { note: "7 字节 BCD，低字节在前", tone: "meta" }),
    field(bytes, 9, 1, "控制码", "04H", { note: "平台下发", tone: "header" }),
    field(bytes, 10, 2, "数据长度", "59 Bytes", { note: "3BH；从数据标识 DI 到 MAC 末字节", tone: "meta" }),
    field(bytes, 12, 2, "数据标识 DI", "8110H", { tone: "meta" }),
    field(bytes, 14, 1, "序列号 SER", "0", { tone: "meta" }),
    field(bytes, 15, 4, "主用 IP 地址", input.primaryIp.trim(), { note: "IPv4，网络顺序", tone: "value" }),
    field(bytes, 19, 2, "主用端口", input.primaryPort.trim(), { note: "2 字节无符号整数，小端", tone: "value" }),
    field(bytes, 21, 4, "备用 IP 地址", "0.0.0.0", { note: "4 字节 IPv4，网络顺序", tone: "meta" }),
    field(bytes, 25, 2, "备用端口", "0", { note: "2 字节无符号整数，小端", tone: "meta" }),
    field(bytes, 27, 4, "网关地址", "0.0.0.0", { note: "4 字节 IPv4，网络顺序", tone: "meta" }),
    field(bytes, 31, 2, "网关端口", "0", { note: "2 字节无符号整数，小端", tone: "meta" }),
    field(bytes, 33, 4, "代理服务器 IP 地址", "0.0.0.0", { note: "4 字节 IPv4，网络顺序", tone: "meta" }),
    field(bytes, 37, 2, "代理服务器端口", "0", { note: "2 字节无符号整数，小端", tone: "meta" }),
    field(bytes, 39, 16, "APN", input.apn.trim(), { note: "16 字节 ASCII，不足补 00H", tone: "value" }),
    field(bytes, 55, 4, "本地 IP 地址", "0.0.0.0", { note: "4 字节 IPv4，网络顺序", tone: "meta" }),
    field(bytes, 59, 2, "本地端口", "0", { note: "2 字节无符号整数，小端", tone: "meta" }),
    field(bytes, 61, 4, "子网掩码", "0.0.0.0", { note: "4 字节", tone: "meta" }),
    field(bytes, 65, 6, "MAC 地址", "00:00:00:00:00:00", { note: "6 字节", tone: "meta" }),
    field(bytes, 71, 1, "校验码 CS", hexByte(checksum), { note: "从 68H 开始累加取低 8 位", tone: "check" }),
    field(bytes, 72, 1, "结束符", "16H", { tone: "header" }),
  ];

  return {
    bytes,
    compactHex: bytes.map(hexByte).join(""),
    spacedHex: hex(bytes),
    checksum: hexByte(checksum),
    fields,
  };
}

/** 将4字节网络顺序地址还原为点分十进制。 */
function decodeIpv4(bytes: number[]): string {
  return bytes.length === 4 ? bytes.join(".") : "—";
}

/** 将固定长度、00H结尾的ASCII字段还原为文本。 */
function decodeAscii(bytes: number[]): string {
  const end = bytes.indexOf(0);
  const content = end >= 0 ? bytes.slice(0, end) : bytes;
  if (content.some((value) => value < 0x20 || value > 0x7e)) throw new Error("APN 字段包含不可识别的非 ASCII 字节。");
  return String.fromCharCode(...content);
}

/**
 * 反向解析沃特曼 04H / 8110H 写通信参数帧。
 * 长度 L 从 DI 起算至 MAC 末字节；CS 与结束符不计入59字节数据区。
 */
export function parseWotmanIpCommand(input: string): ParsedWotmanIpCommand {
  const bytes = parseHex(input);
  const start = findFrameStart(bytes);
  validateFrameEnvelope(bytes, start);
  if ((bytes[start + 1] & 0xf0) !== 0x10) throw new Error(`仪表类型错误：期望 1XH，收到 ${hexByte(bytes[start + 1] ?? 0)}H。`);
  if (bytes[start + 9] !== 0x04) throw new Error(`控制码错误：写通信参数必须为 04H，收到 ${hexByte(bytes[start + 9] ?? 0)}H。`);
  const declaredLength = uint(safeSlice(bytes, start + 10, 2), "le");
  if (declaredLength !== 0x3b) throw new Error(`长度错误：8110H 数据区应为 59 Bytes，当前声明为 ${declaredLength} Bytes。`);
  const actualLength = bytes.length - start - 14;
  if (actualLength !== declaredLength) throw new Error(`长度错误：声明 ${declaredLength} Bytes，DI 至 CS 前实际为 ${actualLength} Bytes。`);
  if (bytes[start + 12] !== 0x81 || bytes[start + 13] !== 0x10) {
    throw new Error(`数据标识错误：写通信参数必须为 8110H，收到 ${hex(safeSlice(bytes, start + 12, 2)).replaceAll(" ", "")}H。`);
  }

  const meterBytes = safeSlice(bytes, start + 2, 7);
  if (meterBytes.some((value) => (value & 0x0f) > 9 || (value >> 4) > 9)) throw new Error("仪表地址不是有效的7字节BCD编码。");
  const meterAddress = [...meterBytes].reverse().map(hexByte).join("");
  const primaryIp = decodeIpv4(safeSlice(bytes, start + 15, 4));
  const primaryPort = uint(safeSlice(bytes, start + 19, 2), "le");
  const backupIp = decodeIpv4(safeSlice(bytes, start + 21, 4));
  const backupPort = uint(safeSlice(bytes, start + 25, 2), "le");
  const gatewayIp = decodeIpv4(safeSlice(bytes, start + 27, 4));
  const gatewayPort = uint(safeSlice(bytes, start + 31, 2), "le");
  const proxyIp = decodeIpv4(safeSlice(bytes, start + 33, 4));
  const proxyPort = uint(safeSlice(bytes, start + 37, 2), "le");
  const apn = decodeAscii(safeSlice(bytes, start + 39, 16));
  const localIp = decodeIpv4(safeSlice(bytes, start + 55, 4));
  const localPort = uint(safeSlice(bytes, start + 59, 2), "le");
  const subnetMask = decodeIpv4(safeSlice(bytes, start + 61, 4));
  const macBytes = safeSlice(bytes, start + 65, 6);
  const macAddress = macBytes.map(hexByte).join(":");
  const checksumOffset = start + 12 + declaredLength;
  const checksum = hexByte(bytes[checksumOffset]);

  const fields: ParsedField[] = [
    ...(start > 0 ? [field(bytes, 0, start, "唤醒字节", `${start} 个 FE`, { note: "不参与 CS 计算", tone: "meta" })] : []),
    field(bytes, start, 1, "起始符", "68H", { tone: "header" }),
    field(bytes, start + 1, 1, "仪表类型", `${hexByte(bytes[start + 1])}H`, { tone: "meta" }),
    field(bytes, start + 2, 7, "仪表地址", meterAddress, { note: "7字节BCD，低字节在前", tone: "meta" }),
    field(bytes, start + 9, 1, "控制码", "04H", { note: "平台下发", tone: "header" }),
    field(bytes, start + 10, 2, "数据长度", "59 Bytes", { note: "从DI至MAC末字节", tone: "meta" }),
    field(bytes, start + 12, 2, "数据标识 DI", "8110H", { tone: "meta" }),
    field(bytes, start + 14, 1, "序列号 SER", String(bytes[start + 14]), { tone: "meta" }),
    field(bytes, start + 15, 4, "主用 IP 地址", primaryIp, { note: "4字节IPv4，网络顺序", tone: "value" }),
    field(bytes, start + 19, 2, "主用端口", String(primaryPort), { note: "2字节无符号整数，小端", tone: "value" }),
    field(bytes, start + 21, 4, "备用 IP 地址", backupIp, { note: "4字节IPv4，网络顺序", tone: "meta" }),
    field(bytes, start + 25, 2, "备用端口", String(backupPort), { note: "2字节无符号整数，小端", tone: "meta" }),
    field(bytes, start + 27, 4, "网关地址", gatewayIp, { note: "4字节IPv4，网络顺序", tone: "meta" }),
    field(bytes, start + 31, 2, "网关端口", String(gatewayPort), { note: "2字节无符号整数，小端", tone: "meta" }),
    field(bytes, start + 33, 4, "代理服务器 IP 地址", proxyIp, { note: "4字节IPv4，网络顺序", tone: "meta" }),
    field(bytes, start + 37, 2, "代理服务器端口", String(proxyPort), { note: "2字节无符号整数，小端", tone: "meta" }),
    field(bytes, start + 39, 16, "APN", apn || "空", { note: "16字节ASCII，不足补00H", tone: "value" }),
    field(bytes, start + 55, 4, "本地 IP 地址", localIp, { note: "4字节IPv4，网络顺序", tone: "meta" }),
    field(bytes, start + 59, 2, "本地端口", String(localPort), { note: "2字节无符号整数，小端", tone: "meta" }),
    field(bytes, start + 61, 4, "子网掩码", subnetMask, { note: "4字节", tone: "meta" }),
    field(bytes, start + 65, 6, "MAC 地址", macAddress, { note: "6字节", tone: "meta" }),
    field(bytes, checksumOffset, 1, "校验码 CS", checksum, { note: "从68H至MAC末字节累加取低8位", tone: "check" }),
    field(bytes, checksumOffset + 1, 1, "结束符", "16H", { tone: "header" }),
  ];

  return {
    bytes,
    compactHex: bytes.map(hexByte).join(""),
    spacedHex: hex(bytes),
    checksum,
    fields,
    meterAddress,
    primaryIp,
    primaryPort,
    backupIp,
    backupPort,
    gatewayIp,
    gatewayPort,
    proxyIp,
    proxyPort,
    apn,
    localIp,
    localPort,
    subnetMask,
    macAddress,
  };
}
