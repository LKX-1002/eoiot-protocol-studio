import { cjt188Parser } from "./cjt188";
import type { ParseOptions, ProtocolParser } from "./types";
import { wotmanParser } from "./wotman";

/** 所有可用协议解析器的唯一注册入口。 */
export const parsers: ProtocolParser[] = [cjt188Parser, wotmanParser];

/**
 * 自动模式选择 detect 分数最高的解析器；手动模式直接按 id 查找。
 * 低于最低可信度时停止解析，避免把随机 HEX 错判为业务报文。
 */
export function parseWithRegistry(bytes: number[], parserId = "auto", options: ParseOptions = {}) {
  if (!bytes.length) throw new Error("请先输入需要解析的 HEX 报文。");
  const parser = parserId === "auto"
    ? [...parsers].sort((a, b) => b.detect(bytes, options) - a.detect(bytes, options))[0]
    : parsers.find((item) => item.id === parserId);
  if (!parser || parser.detect(bytes, options) < 20) throw new Error("当前协议库无法识别这条报文。");
  return parser.parse(bytes, options);
}
