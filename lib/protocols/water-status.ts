import type { ParseResult } from "./types";
import { parseJoymeterStatus } from "./joymeter-status";

/** 只用已解析的两字节状态字作结论；缺失时不推断设备正常。 */
export function smallMeterStatus(result: ParseResult) {
  const word = result.metrics.statusWord;
  if (typeof word !== "string" || !/^0x[0-9a-f]{4}$/i.test(word)) {
    return { state: "unknown" as const, label: "状态未知", alarms: [] as string[], word: null };
  }
  const value = Number.parseInt(word.slice(2), 16);
  const status = parseJoymeterStatus([value & 255, value >>> 8]);
  const alarms = [...status.alarms];
  if (status.valveCode === 3) alarms.unshift("阀门异常");
  if (status.valveCode === 2) {
    return { state: "unknown" as const, label: "状态未知（阀门保留状态）", alarms, word };
  }
  return {
    state: alarms.length ? ("attention" as const) : ("normal" as const),
    label: alarms.length ? "存在异常" : "无异常状态",
    alarms,
    word,
  };
}
