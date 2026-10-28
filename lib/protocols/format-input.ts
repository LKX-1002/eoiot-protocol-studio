import { hex, parseHex } from "./bytes";

/** 仅整理合法的完整字节；不猜测、补齐或丢弃用户输入。 */
export function formatHexIfValid(input: string): string {
  try {
    return hex(parseHex(input));
  } catch {
    return input;
  }
}
