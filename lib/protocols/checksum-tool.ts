import { hex } from "./bytes";
import { modbusCrc16 } from "./modbus";

export type ChecksumKind = "modbus" | "cs";
export function calculateFrameChecksum(bytes: number[], kind: ChecksumKind) {
  if (!bytes.length) throw new Error("请先输入不含校验码的报文。");
  if (kind === "modbus") {
    const crc = modbusCrc16(bytes);
    const check = [crc & 255, crc >>> 8];
    return {
      checksum: hex(check),
      range: hex(bytes),
      rangeLabel: `全部 ${bytes.length} 字节`,
      frame: hex([...bytes, ...check]),
      rule: "CRC16 / MODBUS · 初始 FFFF · 多项式 A001 · 低字节先发",
    };
  }
  let start = 0;
  while (bytes[start] === 0xfe) start++;
  const body = bytes.slice(start);
  if (body[0] !== 0x68) throw new Error("报文应以 68 开始，只允许在前面添加 FE 唤醒字节。");
  const valid645 = body.length >= 10 && body[7] === 0x68 && body.length === 10 + body[9];
  const valid188 = body.length >= 11 && body.length === 11 + body[10];
  const validExtended188 = body.length >= 12 && body.length === 12 + body[10] + body[11] * 256;
  if (!valid645 && !valid188 && !validExtended188)
    throw new Error(
      "帧头或长度字段与输入字节数不一致，请输入 645 / 188 完整帧头和数据域，不要包含 CS 和结束符 16。",
    );
  const cs = body.reduce((sum, byte) => (sum + byte) & 255, 0);
  return {
    checksum: hex([cs]),
    range: hex(body),
    rangeLabel: `字节 ${start}–${bytes.length - 1}（从 0 计，排除 ${start} 个 FE）`,
    frame: hex([...bytes, cs, 0x16]),
    rule: "从起始 68 至数据域最后一字节累加，取低 8 位；补 CS 和结束符 16",
  };
}
