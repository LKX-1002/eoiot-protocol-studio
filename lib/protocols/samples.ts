import { hex } from "./bytes";

/** 为示例帧计算从 68 开始的累加和，并补齐 CS 与结束符 16。 */
function withChecksum(frameWithoutChecksum: number[]) {
  const start = frameWithoutChecksum.indexOf(0x68);
  const checksum = frameWithoutChecksum.slice(start).reduce((sum, value) => (sum + value) & 0xff, 0);
  return [...frameWithoutChecksum, checksum, 0x16];
}

/** 内置示例只用于演示和回归验证，不代表真实设备实时数据。 */
export const samples = {
  cjt188: {
    name: "CJ/T 188 累计流量",
    value: hex(withChecksum([
      0xfe, 0xfe, 0x68, 0x10, 0x71, 0x40, 0x47, 0x00, 0x05, 0x51, 0x00,
      0x81, 0x0b, 0x90, 0x1f, 0x00, 0x78, 0x56, 0x34, 0x12, 0x2c, 0x00, 0x00,
    ])),
  },
};
