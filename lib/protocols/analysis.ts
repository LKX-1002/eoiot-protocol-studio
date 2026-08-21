import type { ParseResult } from "./types";

/** 结论卡片只区分数据完整、部分缺失和解析异常三种展示状态。 */
export type AnalysisLevel = "normal" | "attention" | "abnormal";

/** 结论中的一组核心上报数据。 */
export interface AnalysisItem {
  key: "cumulative" | "time" | "method" | "signals";
  label: string;
  value: string;
  note?: string;
}

/** 面向售前、调试和售后的精简分析结果。 */
export interface AnalysisSummary {
  level: AnalysisLevel;
  statusLabel: string;
  items: AnalysisItem[];
  recommendation: string;
}

/** 将解析指标转换为可读文本，缺失数据统一显示为“报文未提供”。 */
function metricText(result: ParseResult, key: string): string {
  const value = result.metrics[key];
  if (value === null || value === undefined || value === "" || value === "—") return "报文未提供";
  return String(value);
}

/** 流量数值使用与概览区一致的精度和千分位格式。 */
function flowText(result: ParseResult, key: string): string {
  const value = result.metrics[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return "报文未提供";
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} m³`;
}

/** 判断四组指定数据是否完整，不额外推断设备或信号质量。 */
function resolveLevel(result: ParseResult, items: AnalysisItem[]): AnalysisLevel {
  if (result.diagnostics.some((item) => item.level === "bad")) return "abnormal";
  return items.some((item) => item.value.includes("报文未提供")) ? "attention" : "normal";
}

/** 生成小口径水表的累积量、时间、方式和三项信号值。 */
function buildCjt188Summary(result: ParseResult): AnalysisSummary {
  const items: AnalysisItem[] = [
    { key: "cumulative", label: "上报累积量", value: flowText(result, "currentFlow") },
    { key: "time", label: "上报时间", value: metricText(result, "meterTime") },
    { key: "method", label: "上报方式", value: metricText(result, "reportReason") },
    {
      key: "signals",
      label: "信号值",
      value: `RSSI ${metricText(result, "rssi")} · RSRQ ${metricText(result, "rsrq")} · RSRP ${metricText(result, "rsrp")}`,
      note: "协议原始值，未进行信号质量分级",
    },
  ];
  const level = resolveLevel(result, items);
  return {
    level,
    statusLabel: level === "normal" ? "数据完整" : level === "abnormal" ? "解析异常" : "部分缺失",
    items,
    recommendation: level === "normal"
      ? "结合项目现场设定的信号阈值判断通信质量。"
      : "补充完整主动上报报文后再次分析。",
  };
}

/** 生成沃特曼大口径水表对应的四组核心上报信息。 */
function buildWotmanSummary(result: ParseResult): AnalysisSummary {
  const items: AnalysisItem[] = [
    { key: "cumulative", label: "上报累积量", value: flowText(result, "forwardFlow") },
    { key: "time", label: "上报时间", value: metricText(result, "collectTime") },
    { key: "method", label: "上报方式", value: metricText(result, "reportReason") },
    {
      key: "signals",
      label: "信号值",
      value: `CSQ ${metricText(result, "csq")} · RSRQ ${metricText(result, "rsrq")} · RSRP ${metricText(result, "rsrp")}`,
      note: "协议原始值，未进行信号质量分级",
    },
  ];
  const level = resolveLevel(result, items);
  return {
    level,
    statusLabel: level === "normal" ? "数据完整" : level === "abnormal" ? "解析异常" : "部分缺失",
    items,
    recommendation: level === "normal"
      ? "结合项目现场设定的信号阈值判断通信质量。"
      : "当前报文未包含完整上报信息，建议结合字段解释进行人工确认。",
  };
}

/** 协议分发入口；每种协议维护独立规则，避免前端混用字段。 */
export function buildAnalysisSummary(result: ParseResult): AnalysisSummary {
  if (result.protocolId === "cjt188-small") return buildCjt188Summary(result);
  if (result.protocolId === "wotman-big") return buildWotmanSummary(result);

  const items: AnalysisItem[] = [
    { key: "cumulative", label: "上报累积量", value: "报文未提供" },
    { key: "time", label: "上报时间", value: "报文未提供" },
    { key: "method", label: "上报方式", value: "报文未提供" },
    { key: "signals", label: "信号值", value: "报文未提供" },
  ];
  return {
    level: "attention",
    statusLabel: "规则待配置",
    items,
    recommendation: "当前协议尚未配置上报分析规则，请结合字段解释进行人工确认。",
  };
}
