import {
  bcdLittleEndian,
  checksumDiagnostics,
  field,
  findFrameStart,
  formatNumber,
  hexByte,
  meterAddress,
} from "./bytes";
import type { ParseOptions, ParseResult, ProtocolParser } from "./types";

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
  /** 根据帧头、仪表类型、控制码、结束符和单位字节计算匹配度。 */
  detect(bytes) {
    const start = findFrameStart(bytes);
    if (start < 0) return 0;
    let score = 35;
    if (bytes[start + 1] === 0x10) score += 20;
    if ([0x01, 0x81, 0x04, 0x84].includes(bytes[start + 9])) score += 20;
    if (bytes.at(-1) === 0x16) score += 15;
    if (bytes.slice(start + 11, start + 17).some((value) => UNIT_DIVISORS[value])) score += 10;
    return Math.min(score, 100);
  },
  /** 解析 CJ/T 188 通用小口径水表读数响应。 */
  parse(bytes: number[], _options?: ParseOptions): ParseResult {
    const start = findFrameStart(bytes);
    if (start < 0) throw new Error("不是有效的 CJ/T 188 报文：缺少起始符 68。");
    // 帧结构：68 + 仪表类型 1B + 地址 7B + 控制码。
    const controlOffset = start + 9;
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
      field(bytes, start + 1, 1, "仪表类型", "水表", { note: "10H", tone: "meta" }),
      field(bytes, start + 2, 7, "表地址", meterAddress(bytes, start), { note: "低字节在前", tone: "meta" }),
      field(bytes, controlOffset, 1, "控制码", hexByte(control), { tone: "header" }),
      field(bytes, controlOffset + 1, 1, "数据长度", `${length} Bytes`, { tone: "meta" }),
      field(bytes, diOffset, 2, "数据标识 DI", dataIdentifier, { note: "低字节在前", tone: "meta" }),
      field(bytes, reading.offset, 4, "累计流量", formatNumber(total, 3), { unit: unitInfo.label, note: "BCD，小端", tone: "value" }),
      field(bytes, reading.unitOffset, 1, "计量单位", hexByte(bytes[reading.unitOffset] ?? 0), { tone: "value" }),
      field(bytes, stateOffset, 1, "阀门状态", valveStatus, { tone: "status" }),
    ];

    return {
      protocol: this.name,
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
      metrics: { totalFlow: total, valveStatus, meterType: "10H", unit: unitInfo.label },
      fields,
      diagnostics,
      history: [],
      rawBytes: bytes,
    };
  },
};
