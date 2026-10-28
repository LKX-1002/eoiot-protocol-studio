import { hex, hexByte } from "./bytes";
import { calculateFrameChecksum } from "./checksum-tool";

/** DL/T 645-2007 读数据：6 字节 BCD 地址，4 字节 DI 低字节在前并逐字节加 33H。 */
export function buildDlt645ReadCommand(address: string, identifier: string, wakeBytes = 4) {
  const meter = address.trim();
  if (!/^\d{1,12}$/.test(meter)) throw new Error("表号须为 1–12 位数字，少于 12 位会在左侧补 0。");
  const di = identifier.trim().replace(/^0x/i, "").toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(di))
    throw new Error("数据标识 DI 须为 8 位十六进制，按 DI3→DI0 填写。");
  if (!Number.isInteger(wakeBytes) || wakeBytes < 0 || wakeBytes > 4)
    throw new Error("唤醒字节数量须为 0–4。");
  const meterNo = meter.padStart(12, "0");
  const addressBytes = meterNo
    .match(/../g)!
    .reverse()
    .map((value) => parseInt(value, 16));
  const diBytes = di
    .match(/../g)!
    .reverse()
    .map((value) => (parseInt(value, 16) + 0x33) & 255);
  const bytes = [...Array(wakeBytes).fill(0xfe), 0x68, ...addressBytes, 0x68, 0x11, 4, ...diBytes];
  return {
    ...calculateFrameChecksum(bytes, "cs"),
    meterNo,
    di,
    addressHex: hex(addressBytes),
    encodedDi: hex(diBytes),
    control: hexByte(0x11),
  };
}
