import { cjt188Parser } from "./cjt188";
import type { ParseOptions, ProtocolParser } from "./types";
import { wotmanParser } from "./wotman";
import { wotmanCommandParser } from "./wotman-command-parser";
import { joymeterCommandParser } from "./joymeter-command-parser";
import { joymeterMbusParser } from "./joymeter-mbus";
import { dlt645Parser } from "./dlt645";
import { modbusParser } from "./modbus";

/** 所有可用协议解析器的唯一注册入口。 */
export const parsers: ProtocolParser[] = [
  modbusParser,
  dlt645Parser,
  joymeterCommandParser,
  wotmanCommandParser,
  joymeterMbusParser,
  cjt188Parser,
  wotmanParser,
];

/**
 * 选择解析器并执行协议级硬校验。
 * 自动模式会尝试候选解析器，但只有完整通过 validate 的报文才会被接受。
 */
export function validateWithRegistry(
  bytes: number[],
  parserId = "auto",
  options: ParseOptions = {},
) {
  if (!bytes.length) throw new Error("请先输入需要解析的 HEX 报文。");
  if (parserId !== "auto") {
    const selected = parsers.find((item) => item.id === parserId);
    if (!selected) throw new Error("所选协议解析器不存在。");
    selected.validate(bytes, options);
    return selected;
  }

  const ranked = parsers
    .map((parser) => ({ parser, score: parser.detect(bytes, options) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  let firstValidationError: Error | null = null;
  for (const { parser, score } of ranked) {
    try {
      parser.validate(bytes, options);
      return parser;
    } catch (caught) {
      if (!firstValidationError && score >= 50 && caught instanceof Error)
        firstValidationError = caught;
    }
  }
  if (firstValidationError) throw firstValidationError;
  throw new Error("暂未识别协议，请检查报文是否完整，或在协议中心查看当前支持的协议。");
}

/**
 * 自动模式按识别评分排序，选择首个通过严格校验的候选解析器。
 * 手动模式仍执行所选解析器的校验，不绕过边界或校验码检查。
 */
export function parseWithRegistry(bytes: number[], parserId = "auto", options: ParseOptions = {}) {
  const parser = validateWithRegistry(bytes, parserId, options);
  return parser.parse(bytes, options);
}
