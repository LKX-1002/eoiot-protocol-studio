import { field, findFrameStart, hex, hexByte, safeSlice, uint, validateFrameEnvelope } from "./bytes";
import type { ParsedField } from "./types";

export type JoymeterCommandKind = "network" | "base" | "valve" | "reporting" | "start" | "random" | "period";
export type JoymeterValveAction = "open" | "close";

export interface JoymeterCommandInput {
  kind: JoymeterCommandKind;
  meterAddress: string;
  ip?: string;
  port?: string;
  baseReading?: string;
  valveAction?: JoymeterValveAction;
  startHour?: string;
  maxRandomSeconds?: string;
  reportPeriodHours?: string;
}

export interface JoymeterCommandResult {
  bytes: number[];
  compactHex: string;
  spacedHex: string;
  checksum: string;
  fields: ParsedField[];
  meterAddress: string;
  kind: JoymeterCommandKind;
  dataIdentifier: string;
  summary: string;
}

export interface ParsedJoymeterCommand extends JoymeterCommandResult {
  direction: "request" | "response";
  controlCode: string;
  metrics: Record<string, string | number>;
}

const definitions: Record<JoymeterCommandKind, { di: [number, number]; name: string }> = {
  network: { di: [0xa1, 0x84], name: "写服务器 IP 与端口" },
  base: { di: [0xa1, 0x71], name: "写基表读数" },
  valve: { di: [0xa0, 0x17], name: "写开关阀" },
  reporting: { di: [0xa1, 0x80], name: "写 NB&4G 上报参数集合" },
  start: { di: [0xa1, 0x81], name: "写上报起始时间" },
  random: { di: [0xa1, 0x82], name: "写上报最大随机间隔" },
  period: { di: [0xa1, 0x83], name: "写上报周期" },
};

function normalizeAddress(value: string): string {
  const normalized = value.replace(/[\s-]/g, "");
  if (!/^\d{1,14}$/.test(normalized)) throw new Error("仪表地址必须为 1–14 位数字。");
  return normalized.padStart(14, "0");
}

function encodeAddress(value: string): number[] {
  return normalizeAddress(value).match(/.{2}/g)!.reverse().map((token) => Number.parseInt(token, 16));
}

function encodeIpv4(value: string): number[] {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error("服务器 IP 必须是有效的 IPv4 地址，例如 60.205.218.69。");
  }
  return parts.map(Number);
}

function integer(value: string | undefined, label: string, min: number, max: number): number {
  const normalized = value?.trim() ?? "";
  if (!/^\d+$/.test(normalized)) throw new Error(`${label}必须为 ${min}–${max} 的整数。`);
  const result = Number(normalized);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${label}必须为 ${min}–${max} 的整数。`);
  return result;
}

function encodeBcdByte(value: number): number {
  return Math.floor(value / 10) * 16 + value % 10;
}

function encodeBaseReading(value: string | undefined): number[] {
  const normalized = value?.trim() ?? "";
  if (!/^\d{1,8}$/.test(normalized)) throw new Error("基表读数必须为 1–8 位整数，单位为 L。");
  return normalized.padStart(8, "0").match(/.{2}/g)!.reverse().map((token) => Number.parseInt(token, 16));
}

function checksum(bytes: number[], start = 0): number {
  return bytes.slice(start).reduce((sum, value) => (sum + value) & 0xff, 0);
}

function payloadFor(input: JoymeterCommandInput): { bytes: number[]; fields: Array<{ name: string; length: number; value: string; note: string }>; summary: string } {
  if (input.kind === "network") {
    const ip = encodeIpv4(input.ip ?? "");
    const port = integer(input.port, "服务器端口", 1, 65535);
    return {
      bytes: [0x01, ...ip, port & 0xff, (port >> 8) & 0xff],
      fields: [
        { name: "协议号", length: 1, value: "UDP · 01H", note: "协议原文仅标明 01H 为 UDP" },
        { name: "服务器 IP", length: 4, value: input.ip!.trim(), note: "4 字节 IPv4，网络顺序" },
        { name: "服务器端口", length: 2, value: String(port), note: "2 字节无符号整数，小端" },
      ],
      summary: `${input.ip!.trim()}:${port}`,
    };
  }
  if (input.kind === "base") {
    const reading = input.baseReading?.trim() ?? "";
    return {
      bytes: [...encodeBaseReading(reading), 0x00],
      fields: [
        { name: "基表读数", length: 4, value: reading, note: "4 字节 BCD，小端；输入单位 L" },
        { name: "固定单位位", length: 1, value: "00H", note: "协议示例固定追加 00H" },
      ],
      summary: `${reading} L`,
    };
  }
  if (input.kind === "valve") {
    const action = input.valveAction ?? "open";
    return { bytes: [action === "open" ? 0x55 : 0x99], fields: [{ name: "阀门控制字", length: 1, value: action === "open" ? "开阀 · 55H" : "关阀 · 99H", note: "55H 开阀，99H 关阀" }], summary: action === "open" ? "开阀" : "关阀" };
  }

  if (input.kind === "start") {
    const startHour = integer(input.startHour, "上报起始时间", 0, 23);
    return { bytes: [encodeBcdByte(startHour)], fields: [{ name: "上报起始时间", length: 1, value: `${startHour} 点`, note: "1 字节 BCD" }], summary: `${startHour} 点` };
  }
  if (input.kind === "random") {
    const randomSeconds = integer(input.maxRandomSeconds, "最大随机间隔", 10, 65535);
    return { bytes: [randomSeconds & 0xff, (randomSeconds >> 8) & 0xff], fields: [{ name: "最大随机间隔", length: 2, value: `${randomSeconds} 秒`, note: "2 字节无符号整数，小端；协议要求不少于 10 秒" }], summary: `${randomSeconds} 秒` };
  }
  if (input.kind === "period") {
    const periodHours = integer(input.reportPeriodHours, "上报周期", 1, 255);
    return { bytes: [periodHours], fields: [{ name: "上报周期", length: 1, value: `${periodHours} 小时`, note: "1 字节无符号整数" }], summary: `${periodHours} 小时` };
  }

  const startHour = integer(input.startHour, "上报起始时间", 0, 23);
  const startByte = encodeBcdByte(startHour);
  const randomSeconds = integer(input.maxRandomSeconds, "最大随机间隔", 10, 65535);
  const randomBytes = [randomSeconds & 0xff, (randomSeconds >> 8) & 0xff];
  const periodHours = integer(input.reportPeriodHours, "上报周期", 1, 255);

  return {
    bytes: [startByte, ...randomBytes, periodHours],
    fields: [
      { name: "上报起始时间", length: 1, value: `${startHour} 点`, note: "1 字节 BCD" },
      { name: "最大随机间隔", length: 2, value: `${randomSeconds} 秒`, note: "2 字节无符号整数，小端" },
      { name: "上报周期", length: 1, value: `${periodHours} 小时`, note: "1 字节无符号整数" },
    ],
    summary: `${startHour} 点 · 随机 ${randomSeconds} 秒 · 每 ${periodHours} 小时`,
  };
}

export function buildJoymeterCommand(input: JoymeterCommandInput): JoymeterCommandResult {
  const definition = definitions[input.kind];
  const meterAddress = normalizeAddress(input.meterAddress);
  const payload = payloadFor(input);
  const dataLength = 3 + payload.bytes.length;
  const bytes = [0xfe, 0xfe, 0x68, 0x10, ...encodeAddress(meterAddress), 0x24, dataLength, ...definition.di, 0x00, ...payload.bytes];
  const cs = checksum(bytes, 2);
  bytes.push(cs, 0x16);

  const payloadOffset = 16;
  let cursor = payloadOffset;
  const payloadFields = payload.fields.map((item) => {
    const result = field(bytes, cursor, item.length, item.name, item.value, { note: item.note, tone: "value" });
    cursor += item.length;
    return result;
  });
  const fields: ParsedField[] = [
    field(bytes, 0, 2, "唤醒字节", "2 个 FE", { note: "不参与 CS 计算", tone: "meta" }),
    field(bytes, 2, 1, "起始符", "68H", { tone: "header" }),
    field(bytes, 3, 1, "仪表类型", "冷水表 · 10H", { tone: "meta" }),
    field(bytes, 4, 7, "仪表地址", meterAddress, { note: "7 字节 BCD，低字节在前", tone: "meta" }),
    field(bytes, 11, 1, "控制码", "24H", { note: "写通用数据", tone: "header" }),
    field(bytes, 12, 1, "数据域长度", `${dataLength} Bytes`, { note: `${hexByte(dataLength)}H`, tone: "meta" }),
    field(bytes, 13, 2, "数据标识 DI", `${hexByte(definition.di[0])}${hexByte(definition.di[1])}H`, { note: definition.name, tone: "meta" }),
    field(bytes, 15, 1, "序列号 SER", "0", { tone: "meta" }),
    ...payloadFields,
    field(bytes, bytes.length - 2, 1, "校验码 CS", hexByte(cs), { note: "从 68H 至数据域末字节累加取低 8 位", tone: "check" }),
    field(bytes, bytes.length - 1, 1, "结束符", "16H", { tone: "header" }),
  ];

  return { bytes, compactHex: bytes.map(hexByte).join(""), spacedHex: hex(bytes), checksum: hexByte(cs), fields, meterAddress, kind: input.kind, dataIdentifier: hex(definition.di).replaceAll(" ", ""), summary: payload.summary };
}

function decodeAddress(bytes: number[], start: number): string {
  const source = safeSlice(bytes, start + 2, 7);
  if (source.length !== 7 || source.some((value) => (value & 0x0f) > 9 || (value >> 4) > 9)) throw new Error("仪表地址不是有效的 7 字节 BCD 编码。");
  return [...source].reverse().map(hexByte).join("");
}

function kindFromDi(first: number, second: number): JoymeterCommandKind | null {
  return (Object.entries(definitions) as Array<[JoymeterCommandKind, (typeof definitions)[JoymeterCommandKind]]>).find(([, item]) => item.di[0] === first && item.di[1] === second)?.[0] ?? null;
}

export function parseJoymeterCommand(bytes: number[]): ParsedJoymeterCommand {
  const start = findFrameStart(bytes);
  validateFrameEnvelope(bytes, start);
  if (bytes[start + 1] !== 0x10) throw new Error(`仪表类型错误：Joymeter 4G 冷水表应为 10H，收到 ${hexByte(bytes[start + 1] ?? 0)}H。`);
  const control = bytes[start + 9];
  if (control !== 0x24 && control !== 0xa4) throw new Error(`控制码错误：写入帧应为 24H，应答帧应为 A4H，收到 ${hexByte(control ?? 0)}H。`);
  const declaredLength = bytes[start + 10];
  const actualLength = bytes.length - start - 13;
  if (declaredLength !== actualLength) throw new Error(`长度错误：声明 ${declaredLength} Bytes，数据标识至 CS 前实际为 ${actualLength} Bytes。`);
  const kind = kindFromDi(bytes[start + 11], bytes[start + 12]);
  if (!kind) throw new Error(`数据标识错误：当前不支持 ${hex(safeSlice(bytes, start + 11, 2)).replaceAll(" ", "")}H。`);
  const direction = control === 0x24 ? "request" : "response";
  const expectedRequestLength: Record<JoymeterCommandKind, number> = { network: 10, base: 8, valve: 4, reporting: 7, start: 4, random: 5, period: 4 };
  const expected = direction === "response" ? (kind === "valve" ? 5 : 3) : expectedRequestLength[kind];
  if (declaredLength !== expected) throw new Error(`长度错误：${definitions[kind].name}${direction === "request" ? "下行" : "应答"}数据域应为 ${expected} Bytes，当前为 ${declaredLength} Bytes。`);

  const meterAddress = decodeAddress(bytes, start);
  const dataOffset = start + 14;
  const metrics: Record<string, string | number> = {};
  const payloadFields: ParsedField[] = [];
  let summary = direction === "response" ? `${definitions[kind].name}应答` : definitions[kind].name;

  if (direction === "request" && kind === "network") {
    const protocol = bytes[dataOffset];
    const ip = safeSlice(bytes, dataOffset + 1, 4).join(".");
    const port = uint(safeSlice(bytes, dataOffset + 5, 2), "le");
    metrics.protocol = protocol === 0x01 ? "UDP" : `未知 ${hexByte(protocol)}H`;
    metrics.ip = ip; metrics.port = port; summary = `${ip}:${port}`;
    payloadFields.push(field(bytes, dataOffset, 1, "协议号", `${metrics.protocol} · ${hexByte(protocol)}H`, { tone: "value" }), field(bytes, dataOffset + 1, 4, "服务器 IP", ip, { note: "网络顺序", tone: "value" }), field(bytes, dataOffset + 5, 2, "服务器端口", String(port), { note: "小端", tone: "value" }));
  } else if (direction === "request" && kind === "base") {
    const raw = safeSlice(bytes, dataOffset, 4);
    const reading = [...raw].reverse().map(hexByte).join("");
    if (!/^\d{8}$/.test(reading)) throw new Error("基表读数不是有效的 4 字节 BCD 编码。");
    metrics.baseReading = reading; summary = `${reading} L`;
    payloadFields.push(field(bytes, dataOffset, 4, "基表读数", reading, { note: "4 字节 BCD，小端；单位 L", tone: "value" }), field(bytes, dataOffset + 4, 1, "固定单位位", `${hexByte(bytes[dataOffset + 4])}H`, { tone: "meta" }));
  } else if (direction === "request" && kind === "valve") {
    const action = bytes[dataOffset] === 0x55 ? "开阀" : bytes[dataOffset] === 0x99 ? "关阀" : "未知操作";
    if (action === "未知操作") throw new Error("阀门控制字无效：仅支持 55H 开阀或 99H 关阀。");
    metrics.valveAction = action; summary = action;
    payloadFields.push(field(bytes, dataOffset, 1, "阀门控制字", `${action} · ${hexByte(bytes[dataOffset])}H`, { tone: "value" }));
  } else if (direction === "request") {
    if (kind === "start" || kind === "reporting") {
      const bcd = hexByte(bytes[dataOffset]);
      if (!/^\d{2}$/.test(bcd) || Number(bcd) > 23) throw new Error("上报起始时间不是有效的 00–23 BCD 小时。");
      metrics.startHour = Number(bcd);
      payloadFields.push(field(bytes, dataOffset, 1, "上报起始时间", `${Number(bcd)} 点`, { note: "1 字节 BCD", tone: "value" }));
    }
    if (kind === "random" || kind === "reporting") {
      const offset = kind === "reporting" ? dataOffset + 1 : dataOffset;
      const value = uint(safeSlice(bytes, offset, 2), "le");
      metrics.maxRandomSeconds = value;
      payloadFields.push(field(bytes, offset, 2, "最大随机间隔", `${value} 秒`, { note: "2 字节小端", tone: "value" }));
    }
    if (kind === "period" || kind === "reporting") {
      const offset = kind === "reporting" ? dataOffset + 3 : dataOffset;
      metrics.reportPeriodHours = bytes[offset];
      payloadFields.push(field(bytes, offset, 1, "上报周期", `${bytes[offset]} 小时`, { tone: "value" }));
    }
    summary = kind === "reporting" ? `${metrics.startHour} 点 · 随机 ${metrics.maxRandomSeconds} 秒 · 每 ${metrics.reportPeriodHours} 小时` : String(Object.values(metrics)[0] ?? definitions[kind].name);
  } else if (kind === "valve") {
    const status = uint(safeSlice(bytes, dataOffset, 2), "le");
    metrics.status = status; summary = status === 0 ? "执行成功 · ST=0000H" : `设备状态 ${hex(safeSlice(bytes, dataOffset, 2)).replaceAll(" ", "")}H`;
    payloadFields.push(field(bytes, dataOffset, 2, "状态 ST", summary, { note: "2 字节状态位", tone: "status" }));
  }

  const checksumOffset = bytes.length - 2;
  const fields: ParsedField[] = [
    ...(start ? [field(bytes, 0, start, "唤醒字节", `${start} 个 FE`, { note: "不参与 CS 计算", tone: "meta" })] : []),
    field(bytes, start, 1, "起始符", "68H", { tone: "header" }), field(bytes, start + 1, 1, "仪表类型", "冷水表 · 10H", { tone: "meta" }),
    field(bytes, start + 2, 7, "仪表地址", meterAddress, { note: "7 字节 BCD，低字节在前", tone: "meta" }),
    field(bytes, start + 9, 1, "控制码", direction === "request" ? "24H · 写入" : "A4H · 应答", { tone: "header" }),
    field(bytes, start + 10, 1, "数据域长度", `${declaredLength} Bytes`, { tone: "meta" }),
    field(bytes, start + 11, 2, "数据标识 DI", `${hexByte(bytes[start + 11])}${hexByte(bytes[start + 12])}H`, { note: definitions[kind].name, tone: "meta" }),
    field(bytes, start + 13, 1, "序列号 SER", String(bytes[start + 13]), { tone: "meta" }), ...payloadFields,
    field(bytes, checksumOffset, 1, "校验码 CS", hexByte(bytes[checksumOffset]), { note: "从 68H 起累加取低 8 位", tone: "check" }), field(bytes, checksumOffset + 1, 1, "结束符", "16H", { tone: "header" }),
  ];

  return { bytes, compactHex: bytes.map(hexByte).join(""), spacedHex: hex(bytes), checksum: hexByte(bytes[checksumOffset]), fields, meterAddress, kind, dataIdentifier: `${hexByte(bytes[start + 11])}${hexByte(bytes[start + 12])}`, summary, direction, controlCode: hexByte(control), metrics };
}

export function joymeterDefinition(kind: JoymeterCommandKind) {
  return definitions[kind];
}
