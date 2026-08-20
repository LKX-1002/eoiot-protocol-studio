import {
  bcdLittleEndian,
  checksumDiagnostics,
  field,
  findFrameStart,
  formatNumber,
  hexByte,
  meterAddress,
  validateFrameEnvelope,
} from "./bytes";
import type { ParseOptions, ParseResult, ProtocolParser } from "./types";
import { getWaterMeterType } from "./meter-types";

const UNIT_DIVISORS: Record<number, { divisor: number; label: string }> = {
  0x29: { divisor: 10, label: "m³" },
  0x2b: { divisor: 10, label: "m³" },
  0x2c: { divisor: 1, label: "m³" },
  0x2d: { divisor: 0.1, label: "m³" },
  0x2e: { divisor: 0.01, label: "m³" },
};

/**
 * 兼容标准位置和原 Java 实现中的偏移差异。
 * 优先以合法单位字节为锚点定位 4 字节累计流量。
 */
function locateReading(bytes: number[], controlOffset: number) {
  const candidates = [controlOffset + 5, controlOffset + 4];
  for (const offset of candidates) {
    for (const unitGap of [4, 5]) {
      const unitOffset = offset + unitGap;
      if (UNIT_DIVISORS[bytes[unitOffset]]) return { offset, unitOffset };
    }
  }
  return { offset: controlOffset + 5, unitOffset: controlOffset + 9 };
}

export const cjt188Parser: ProtocolParser = {
  id: "cjt188-small",
  name: "CJ/T 188 小口径水表",
  category: "water",
  status: "ready",
  /** 根据完整结构计算匹配度；标准样例通过全部关键特征时为 100%。 */
  detect(bytes) {
    const start = findFrameStart(bytes);
    if (start < 0) return 0;
    let score = 25;
    if (getWaterMeterType(bytes[start + 1])) score += 25;
    if ([0x01, 0x81, 0x04, 0x84].includes(bytes[start + 9])) score += 15;
    // 不把匹配度绑定到单一 DI；不同水表会返回 901F、9020 等合法数据标识。
    if (bytes.length > start + 12) score += 15;
    if (bytes.at(-1) === 0x16) score += 10;
    const reading = locateReading(bytes, start + 9);
    if (UNIT_DIVISORS[bytes[reading.unitOffset]]) score += 10;
    return Math.min(score, 100);
  },
  /** 错误帧在字段解析前直接拒绝，避免用默认值伪装成有效读数。 */
  validate(bytes) {
    const start = findFrameStart(bytes);
    validateFrameEnvelope(bytes, start);
    const meterType = getWaterMeterType(bytes[start + 1]);
    if (!meterType) throw new Error(`仪表类型错误：${hexByte(bytes[start + 1] ?? 0)}H 不属于水表类型 10H–19H。`);
    if (![0x01, 0x81, 0x04, 0x84].includes(bytes[start + 9])) {
      throw new Error(`控制码错误：暂不支持 ${hexByte(bytes[start + 9] ?? 0)}H。`);
    }

    const declaredLength = bytes[start + 10];
    // 固定区 11B + DATA(L) + CS 1B，随后才是结束符 16。
    const expectedEndOffset = start + 12 + declaredLength;
    if (expectedEndOffset !== bytes.length - 1) {
      const actualLength = Math.max(0, bytes.length - start - 13);
      throw new Error(`长度字段错误：声明 ${declaredLength} Bytes，按当前帧实际为 ${actualLength} Bytes。`);
    }

    const address = bytes.slice(start + 2, start + 9);
    if (address.some((value) => (value & 0x0f) > 9 || (value >> 4) > 9)) {
      throw new Error("表地址错误：地址字段不是有效的 BCD 编码。");
    }

    const reading = locateReading(bytes, start + 9);
    if (!UNIT_DIVISORS[bytes[reading.unitOffset]]) throw new Error("数据区错误：未找到支持的累计流量单位。");
    if (bcdLittleEndian(bytes.slice(reading.offset, reading.offset + 4), 2) === null) {
      throw new Error("数据区错误：累计流量不是有效的 BCD 编码。");
    }
  },
  /** 解析 CJ/T 188 通用小口径水表读数响应。 */
  parse(bytes: number[], _options?: ParseOptions): ParseResult {
    const start = findFrameStart(bytes);
    if (start < 0) throw new Error("不是有效的 CJ/T 188 报文：缺少起始符 68。");
    // 帧结构：68 + 仪表类型 1B + 地址 7B + 控制码。
    const controlOffset = start + 9;
    const meterType = getWaterMeterType(bytes[start + 1]);
    if (!meterType) throw new Error("无法解析仪表类型：当前类型不属于水表协议。");
    const control = bytes[controlOffset] ?? 0;
    const length = bytes[controlOffset + 1] ?? Math.max(0, bytes.length - controlOffset - 4);
    const diOffset = controlOffset + 2;
    const dataIdentifier = bytes.length > diOffset + 1
      ? `${hexByte(bytes[diOffset + 1])}${hexByte(bytes[diOffset])}`
      : "—";
    // 通过单位字节反推累计流量位置，以兼容两种历史实现。
    const reading = locateReading(bytes, controlOffset);
    const rawReading = bytes.slice(reading.offset, reading.offset + 4);
    const bcdValue = bcdLittleEndian(rawReading, 2);
    const unitInfo = UNIT_DIVISORS[bytes[reading.unitOffset]] ?? { divisor: 1, label: "m³" };
    const total = bcdValue === null ? null : bcdValue / unitInfo.divisor;
    // Java 源码从帧尾倒数第 4 字节读取状态，同时兼容紧随单位的位置。
    const stateOffset = Math.max(reading.unitOffset + 1, bytes.length - 4);
    const stateCode = bytes[stateOffset];
    const valveStatus = stateCode === 0x01 ? "关闭" : stateCode === 0x03 ? "异常" : stateCode === 0x00 ? "开启" : "未知";
    const diagnostics = checksumDiagnostics(bytes, start);
    if (bcdValue === null) diagnostics.push({ level: "warn", text: "累计流量不是有效 BCD，已保留原始字节。" });
    else diagnostics.push({ level: "ok", text: "累计流量 BCD 与单位换算完成。" });

    // fields 同时用于字段表格和字节地图着色。
    const fields = [
      field(bytes, start, 1, "帧起始符", "68", { tone: "header" }),
      field(bytes, start + 1, 1, "仪表类型", meterType.label, { note: meterType.reserved ? `${meterType.codeLabel}，标准保留码` : meterType.codeLabel, tone: "meta" }),
      field(bytes, start + 2, 7, "表地址", meterAddress(bytes, start), { note: "低字节在前", tone: "meta" }),
      field(bytes, controlOffset, 1, "控制码", hexByte(control), { tone: "header" }),
      field(bytes, controlOffset + 1, 1, "数据长度", `${length} Bytes`, { tone: "meta" }),
      field(bytes, diOffset, 2, "数据标识 DI", dataIdentifier, { note: "低字节在前", tone: "meta" }),
      field(bytes, reading.offset, 4, "累计流量", formatNumber(total, 3), { unit: unitInfo.label, note: "BCD，小端", tone: "value" }),
      field(bytes, reading.unitOffset, 1, "计量单位", hexByte(bytes[reading.unitOffset] ?? 0), { tone: "value" }),
      field(bytes, stateOffset, 1, "阀门状态", valveStatus, { tone: "status" }),
    ];

    return {
      protocol: `CJ/T 188 ${meterType.label}`,
      protocolId: this.id,
      category: "water",
      categoryLabel: "水表协议",
      manufacturer: "CJ/T 188 通用设备",
      confidence: this.detect(bytes),
      meterNo: meterAddress(bytes, start),
      controlCode: hexByte(control),
      dataIdentifier,
      dataLength: length,
      coreValue: total === null ? "无法识别" : `${formatNumber(total, 3)} m³`,
      metrics: { totalFlow: total, valveStatus, meterType: `${meterType.label} · ${meterType.codeLabel}`, unit: unitInfo.label },
      fields,
      diagnostics,
      history: [],
      rawBytes: bytes,
    };
  },
};
