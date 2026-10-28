import { parseHex } from "../protocols/bytes";
import type { ModbusDecodeConfig, ParseResult } from "../protocols/types";

export const RECORD_LIMIT = 20;
export const RECORD_STORAGE_KEY = "eoiot-records";
const RECORD_VERSION = 1;
export interface ParseRecord {
  id: string;
  createdAt: string;
  protocol: string;
  coreValue: string;
  meterNo: string;
  raw: string;
  modbusProfile?: "uint16-energy" | "raw";
  modbusDecode?: ModbusDecodeConfig;
  modbusRaw?: boolean;
}
export interface RecordStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate imported/local metadata before it can reach rendering or protocol decoders. */
export function isModbusDecodeConfig(value: unknown): value is ModbusDecodeConfig {
  if (!object(value)) return false;
  const type = value.dataType;
  if (typeof type !== "string" || !["UINT16", "INT16", "UINT32", "INT32", "FLOAT32"].includes(type))
    return false;
  const orders = type.endsWith("16") ? ["AB", "BA"] : ["ABCD", "BADC", "CDAB", "DCBA"];
  return (
    typeof value.byteOrder === "string" &&
    orders.includes(value.byteOrder) &&
    typeof value.scale === "number" &&
    Number.isFinite(value.scale) &&
    typeof value.registerOffset === "number" &&
    Number.isInteger(value.registerOffset) &&
    value.registerOffset >= 0 &&
    value.registerOffset <= 124 &&
    typeof value.valueCount === "number" &&
    Number.isInteger(value.valueCount) &&
    value.valueCount >= 1 &&
    value.valueCount <= 125 &&
    typeof value.label === "string" &&
    value.label.length <= 40 &&
    typeof value.unit === "string" &&
    value.unit.length <= 24 &&
    (value.decimals === undefined ||
      (typeof value.decimals === "number" &&
        Number.isInteger(value.decimals) &&
        value.decimals >= 0 &&
        value.decimals <= 8)) &&
    (value.rangeMode === undefined || value.rangeMode === "all" || value.rangeMode === "custom") &&
    (value.model === undefined || (typeof value.model === "string" && value.model.length <= 40)) &&
    (value.registerAddress === undefined ||
      (typeof value.registerAddress === "number" &&
        Number.isInteger(value.registerAddress) &&
        value.registerAddress >= 0 &&
        value.registerAddress <= 65535))
  );
}

function readRecord(value: unknown): ParseRecord | null {
  if (!object(value)) return null;
  for (const key of ["id", "createdAt", "protocol", "coreValue", "meterNo", "raw"] as const) {
    if (typeof value[key] !== "string") return null;
  }
  if (!value.id || !value.protocol || !Number.isFinite(Date.parse(value.createdAt as string)))
    return null;
  if (value.modbusDecode !== undefined && !isModbusDecodeConfig(value.modbusDecode)) return null;
  if (
    value.modbusProfile !== undefined &&
    !["uint16-energy", "raw"].includes(String(value.modbusProfile))
  )
    return null;
  if (value.modbusRaw !== undefined && typeof value.modbusRaw !== "boolean") return null;
  try {
    if (!parseHex(value.raw as string).length) return null;
  } catch {
    return null;
  }
  return {
    id: value.id as string,
    createdAt: value.createdAt as string,
    protocol: value.protocol as string,
    coreValue: value.coreValue as string,
    meterNo: value.meterNo as string,
    raw: value.raw as string,
    ...(value.modbusDecode ? { modbusDecode: value.modbusDecode as ModbusDecodeConfig } : {}),
    ...(value.modbusProfile
      ? { modbusProfile: value.modbusProfile as ParseRecord["modbusProfile"] }
      : {}),
    ...(typeof value.modbusRaw === "boolean" ? { modbusRaw: value.modbusRaw } : {}),
  };
}

/** Storage failures are returned as notices, never thrown into a successful parse. */
export function createLocalRecordStore(getStorage: () => RecordStorage) {
  return {
    load(): { records: ParseRecord[]; notice: string; writable: boolean } {
      try {
        const raw = getStorage().getItem(RECORD_STORAGE_KEY);
        if (raw === null) return { records: [], notice: "", writable: true };
        const decoded: unknown = JSON.parse(raw);
        if (object(decoded) && decoded.version !== RECORD_VERSION)
          return {
            records: [],
            notice: "记录版本不受支持，已保留原数据；当前新增记录仅暂存于本次页面。",
            writable: false,
          };
        // Legacy array records remain readable; migration is written only on the next explicit mutation.
        const source: unknown = Array.isArray(decoded)
          ? decoded
          : object(decoded)
            ? decoded.records
            : undefined;
        if (!Array.isArray(source))
          return {
            records: [],
            notice: "本机记录格式异常，未载入；原始存储未改动。",
            writable: false,
          };
        const valid = source
          .map(readRecord)
          .filter((record): record is ParseRecord => record !== null);
        const skipped = source.length - valid.length;
        return {
          records: valid.slice(0, RECORD_LIMIT),
          notice: skipped ? `已跳过 ${skipped} 条无效记录，原始存储未改动。` : "",
          writable: skipped === 0,
        };
      } catch {
        return {
          records: [],
          notice: "无法读取本机记录，数据未改动；仍可继续解析，新记录可能无法持久保存。",
          writable: false,
        };
      }
    },
    save(records: ParseRecord[]): { ok: boolean; notice: string } {
      try {
        if (records.some((record) => !readRecord(record)))
          return { ok: false, notice: "记录格式校验失败，未写入本机存储。" };
        getStorage().setItem(
          RECORD_STORAGE_KEY,
          JSON.stringify({ version: RECORD_VERSION, records: records.slice(0, RECORD_LIMIT) }),
        );
        return { ok: true, notice: "" };
      } catch {
        return {
          ok: false,
          notice: "本机存储不可用或空间不足。解析结果不受影响，记录仅暂存于本次页面。",
        };
      }
    },
    clear(): { ok: boolean; notice: string } {
      try {
        getStorage().removeItem(RECORD_STORAGE_KEY);
        return { ok: true, notice: "" };
      } catch {
        return { ok: false, notice: "无法清除本机存储，记录仍保留，请检查浏览器存储权限。" };
      }
    },
  };
}

export function createParseRecord(parsed: ParseResult, raw: string): ParseRecord {
  let config: ModbusDecodeConfig | undefined;
  if (typeof parsed.metrics.decodeConfig === "string") {
    try {
      const value: unknown = JSON.parse(parsed.metrics.decodeConfig);
      if (isModbusDecodeConfig(value)) config = value;
    } catch {
      /* Keep the raw frame even if optional decode metadata is invalid. */
    }
  }
  return {
    id: globalThis.crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    protocol: parsed.protocol,
    coreValue: parsed.coreValue,
    meterNo: parsed.meterNo,
    raw,
    ...(parsed.protocolId === "modbus-rtu"
      ? { modbusDecode: config, modbusRaw: parsed.metrics.decodeConfig === null }
      : {}),
  };
}
