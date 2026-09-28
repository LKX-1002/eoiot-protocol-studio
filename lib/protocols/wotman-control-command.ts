import { field, findFrameStart, hex, hexByte, parseHex, safeSlice, uint, validateFrameEnvelope } from "./bytes";
import type { ParsedField } from "./types";

export type ValveAction = "open" | "close";
export type HourMinutePair = [number | null, number | null];

interface BaseCommandInput { meterAddress: string; }
export interface ValveCommandInput extends BaseCommandInput { action: ValveAction; }
export interface UploadScheduleInput extends BaseCommandInput { schedule: HourMinutePair[]; }
export interface CollectionIntervalInput extends BaseCommandInput { intervalMinutes: string; }

interface BaseCommandResult {
  bytes: number[];
  compactHex: string;
  spacedHex: string;
  checksum: string;
  fields: ParsedField[];
  meterAddress: string;
}

export interface ValveCommandResult extends BaseCommandResult { action: ValveAction; actionLabel: string; }
export interface UploadScheduleResult extends BaseCommandResult { schedule: HourMinutePair[]; enabledCount: number; }
export interface CollectionIntervalResult extends BaseCommandResult { intervalMinutes: number; }

function encodeMeterAddress(value: string): { bytes: number[]; display: string } {
  const normalized = value.replace(/[\s-]/g, "");
  if (!/^\d{1,14}$/.test(normalized)) throw new Error("仪表地址必须为 1–14 位数字。");
  const display = normalized.padStart(14, "0");
  return { bytes: display.match(/.{2}/g)!.reverse().map((token) => Number.parseInt(token, 16)), display };
}

function decodeMeterAddress(bytes: number[], start: number) {
  const raw = safeSlice(bytes, start + 2, 7);
  if (raw.length !== 7 || raw.some((value) => (value & 0x0f) > 9 || (value >> 4) > 9)) throw new Error("仪表地址不是有效的 7 字节 BCD。");
  return [...raw].reverse().map(hexByte).join("");
}

function buildFrame(meterAddress: string, di: [number, number], payload: number[]) {
  const address = encodeMeterAddress(meterAddress);
  const dataLength = 3 + payload.length;
  const bytes = [0x68, 0x10, ...address.bytes, 0x04, dataLength & 0xff, (dataLength >> 8) & 0xff, ...di, 0x00, ...payload];
  const checksum = bytes.reduce((sum, value) => (sum + value) & 0xff, 0);
  bytes.push(checksum, 0x16);
  return { bytes, checksum, meterAddress: address.display, dataLength };
}

function parseFrame(input: string | number[], expectedDi: [number, number], expectedLength: number) {
  const bytes = typeof input === "string" ? parseHex(input) : input;
  const start = findFrameStart(bytes);
  validateFrameEnvelope(bytes, start);
  if ((bytes[start + 1] & 0xf0) !== 0x10) throw new Error("仪表类型错误：当前指令要求 1XH 水表类型。");
  if (bytes[start + 9] !== 0x04) throw new Error(`控制码错误：下行写入必须为 04H，收到 ${hexByte(bytes[start + 9] ?? 0)}H。`);
  const declaredLength = uint(safeSlice(bytes, start + 10, 2), "le");
  if (declaredLength !== expectedLength) throw new Error(`长度错误：该指令数据区应为 ${expectedLength} Bytes，当前声明为 ${declaredLength} Bytes。`);
  const actualLength = bytes.length - start - 14;
  if (actualLength !== declaredLength) throw new Error(`长度错误：声明 ${declaredLength} Bytes，DI 至 CS 前实际为 ${actualLength} Bytes。`);
  if (bytes[start + 12] !== expectedDi[0] || bytes[start + 13] !== expectedDi[1]) throw new Error(`数据标识错误：期望 ${expectedDi.map(hexByte).join("")}H。`);
  return { bytes, start, meterAddress: decodeMeterAddress(bytes, start), checksumOffset: start + 12 + declaredLength };
}

function commonFields(bytes: number[], start: number, meterAddress: string, dataLength: number, di: string, purpose: string): ParsedField[] {
  return [
    ...(start > 0 ? [field(bytes, 0, start, "唤醒字节", `${start} 个 FE`, { note: "不参与 CS 计算", tone: "meta" })] : []),
    field(bytes, start, 1, "起始符", "68H", { tone: "header" }),
    field(bytes, start + 1, 1, "仪表类型", `${hexByte(bytes[start + 1])}H`, { tone: "meta" }),
    field(bytes, start + 2, 7, "仪表地址", meterAddress, { note: "7 字节 BCD，低字节在前", tone: "meta" }),
    field(bytes, start + 9, 1, "控制码", "04H", { note: "平台下发", tone: "header" }),
    field(bytes, start + 10, 2, "数据长度", `${dataLength} Bytes`, { note: "从 DI 至数据末字节", tone: "meta" }),
    field(bytes, start + 12, 2, "数据标识 DI", `${di}H`, { note: purpose, tone: "meta" }),
    field(bytes, start + 14, 1, "序列号 SER", String(bytes[start + 14]), { tone: "meta" }),
  ];
}

function finishResult(bytes: number[], fields: ParsedField[], checksumOffset: number) {
  fields.push(
    field(bytes, checksumOffset, 1, "校验码 CS", hexByte(bytes[checksumOffset]), { note: "从 68H 至数据末字节累加取低 8 位", tone: "check" }),
    field(bytes, checksumOffset + 1, 1, "结束符", "16H", { tone: "header" }),
  );
  return { compactHex: bytes.map(hexByte).join(""), spacedHex: hex(bytes), checksum: hexByte(bytes[checksumOffset]) };
}

export function buildValveCommand(input: ValveCommandInput): ValveCommandResult {
  const control = input.action === "open" ? 0x55 : 0x99;
  const frame = buildFrame(input.meterAddress, [0xa0, 0x17], [control]);
  const fields = commonFields(frame.bytes, 0, frame.meterAddress, 4, "A017", "采集器阀门控制");
  fields.push(field(frame.bytes, 15, 1, "阀门控制", input.action === "open" ? "开阀" : "关阀", { note: `${hexByte(control)}H：${input.action === "open" ? "开阀" : "关阀"}`, tone: "value" }));
  return { bytes: frame.bytes, fields, meterAddress: frame.meterAddress, action: input.action, actionLabel: input.action === "open" ? "开阀" : "关阀", ...finishResult(frame.bytes, fields, 16) };
}

export function parseValveCommand(input: string | number[]): ValveCommandResult {
  const parsed = parseFrame(input, [0xa0, 0x17], 4);
  const value = parsed.bytes[parsed.start + 15];
  if (value !== 0x55 && value !== 0x99) throw new Error(`阀门控制字错误：55H 为开阀、99H 为关阀，当前为 ${hexByte(value ?? 0)}H。`);
  const action: ValveAction = value === 0x55 ? "open" : "close";
  const fields = commonFields(parsed.bytes, parsed.start, parsed.meterAddress, 4, "A017", "采集器阀门控制");
  fields.push(field(parsed.bytes, parsed.start + 15, 1, "阀门控制", action === "open" ? "开阀" : "关阀", { note: `${hexByte(value)}H`, tone: "value" }));
  return { bytes: parsed.bytes, fields, meterAddress: parsed.meterAddress, action, actionLabel: action === "open" ? "开阀" : "关阀", ...finishResult(parsed.bytes, fields, parsed.checksumOffset) };
}

function normalizeSchedule(schedule: HourMinutePair[]) {
  if (schedule.length !== 24) throw new Error("自动上传时间必须完整提供 0–23 点共 24 组设置。");
  return schedule.map((pair, hour) => pair.map((value) => {
    if (value === null) return null;
    if (!Number.isInteger(value) || value < 0 || value > 59) throw new Error(`${hour} 点的分钟值必须为 0–59，留空表示停用。`);
    return value;
  }) as HourMinutePair);
}

export function buildUploadScheduleCommand(input: UploadScheduleInput): UploadScheduleResult {
  const schedule = normalizeSchedule(input.schedule);
  const payload = schedule.flatMap((pair) => pair.map((value) => value ?? 0xff));
  const frame = buildFrame(input.meterAddress, [0x81, 0x04], payload);
  const fields = commonFields(frame.bytes, 0, frame.meterAddress, 51, "8104", "自动上传数据时间参数");
  schedule.forEach((pair, hour) => fields.push(field(frame.bytes, 15 + hour * 2, 2, `${hour.toString().padStart(2, "0")} 点上传分钟`, pair.map((value) => value === null ? "停用" : `${value.toString().padStart(2, "0")} 分`).join("、"), { note: "两个 1 字节分钟值；FFH 表示停用", tone: "value" })));
  const enabledCount = schedule.flat().filter((value) => value !== null).length;
  return { bytes: frame.bytes, fields, meterAddress: frame.meterAddress, schedule, enabledCount, ...finishResult(frame.bytes, fields, 63) };
}

export function parseUploadScheduleCommand(input: string | number[]): UploadScheduleResult {
  const parsed = parseFrame(input, [0x81, 0x04], 51);
  const schedule: HourMinutePair[] = Array.from({ length: 24 }, (_, hour) => {
    const pair = safeSlice(parsed.bytes, parsed.start + 15 + hour * 2, 2);
    return pair.map((value) => {
      if (value === 0xff) return null;
      if (value > 59) throw new Error(`${hour} 点上传分钟包含无效值 ${hexByte(value)}H。`);
      return value;
    }) as HourMinutePair;
  });
  const fields = commonFields(parsed.bytes, parsed.start, parsed.meterAddress, 51, "8104", "自动上传数据时间参数");
  schedule.forEach((pair, hour) => fields.push(field(parsed.bytes, parsed.start + 15 + hour * 2, 2, `${hour.toString().padStart(2, "0")} 点上传分钟`, pair.map((value) => value === null ? "停用" : `${value.toString().padStart(2, "0")} 分`).join("、"), { note: "两个 1 字节分钟值；FFH 表示停用", tone: "value" })));
  return { bytes: parsed.bytes, fields, meterAddress: parsed.meterAddress, schedule, enabledCount: schedule.flat().filter((value) => value !== null).length, ...finishResult(parsed.bytes, fields, parsed.checksumOffset) };
}

export function buildCollectionIntervalCommand(input: CollectionIntervalInput): CollectionIntervalResult {
  if (!/^\d+$/.test(input.intervalMinutes.trim())) throw new Error("采集间隔必须为 1–255 分钟的整数。");
  const intervalMinutes = Number(input.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 255) throw new Error("采集间隔必须为 1–255 分钟的整数。");
  const frame = buildFrame(input.meterAddress, [0x81, 0x05], [intervalMinutes]);
  const fields = commonFields(frame.bytes, 0, frame.meterAddress, 4, "8105", "数据采集间隔时间参数");
  fields.push(field(frame.bytes, 15, 1, "采集间隔", String(intervalMinutes), { unit: "分钟", note: `${hexByte(intervalMinutes)}H，无符号整数`, tone: "value" }));
  return { bytes: frame.bytes, fields, meterAddress: frame.meterAddress, intervalMinutes, ...finishResult(frame.bytes, fields, 16) };
}

export function parseCollectionIntervalCommand(input: string | number[]): CollectionIntervalResult {
  const parsed = parseFrame(input, [0x81, 0x05], 4);
  const intervalMinutes = parsed.bytes[parsed.start + 15];
  if (!intervalMinutes) throw new Error("采集间隔不能为 0 分钟。");
  const fields = commonFields(parsed.bytes, parsed.start, parsed.meterAddress, 4, "8105", "数据采集间隔时间参数");
  fields.push(field(parsed.bytes, parsed.start + 15, 1, "采集间隔", String(intervalMinutes), { unit: "分钟", note: `${hexByte(intervalMinutes)}H，无符号整数`, tone: "value" }));
  return { bytes: parsed.bytes, fields, meterAddress: parsed.meterAddress, intervalMinutes, ...finishResult(parsed.bytes, fields, parsed.checksumOffset) };
}
