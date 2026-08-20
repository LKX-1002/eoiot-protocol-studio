import { cjt188Parser } from "./cjt188";
import type { ParseOptions, ProtocolParser } from "./types";
import { wotmanParser } from "./wotman";

/** 所有可用协议解析器的唯一注册入口。 */
export const parsers: ProtocolParser[] = [cjt188Parser, wotmanParser];

/**
 * 选择解析器并执行协议级硬校验。
 * 自动模式会尝试候选解析器，但只有完整通过 validate 的报文才会被接受。
 */
export function validateWithRegistry(bytes: number[], parserId = "auto", options: ParseOptions = {}) {
  if (!bytes.length) throw new Error("请先输入需要解析的 HEX 报文。");
  if (parserId !== "auto") {
    const selected = parsers.find((item) => item.id === parserId);
    if (!selected) throw new Error("所选协议解析器不存在。");
    selected.validate(bytes, options);
    return selected;
  }

  const ranked = [...parsers].sort((a, b) => b.detect(bytes, options) - a.detect(bytes, options));
  let firstValidationError: Error | null = null;
  for (const parser of ranked) {
    try {
      parser.validate(bytes, options);
      return parser;
    } catch (caught) {
      if (!firstValidationError && caught instanceof Error) firstValidationError = caught;
    }
  }
  if (firstValidationError) throw firstValidationError;
  throw new Error("无法识别协议：报文不符合当前协议库的帧结构。");
}

/**
 * 自动模式选择 detect 分数最高的解析器；手动模式直接按 id 查找。
 * 低于最低可信度时停止解析，避免把随机 HEX 错判为业务报文。
 */
export function parseWithRegistry(bytes: number[], parserId = "auto", options: ParseOptions = {}) {
  const parser = validateWithRegistry(bytes, parserId, options);
  return parser.parse(bytes, options);
}
