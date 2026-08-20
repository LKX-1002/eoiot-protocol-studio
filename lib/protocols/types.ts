/** 诊断级别：通过、需要关注、解析失败。 */
export type DiagnosticLevel = "ok" | "warn" | "bad";

/** 单条协议诊断信息，供诊断列表统一展示。 */
export interface Diagnostic {
  level: DiagnosticLevel;
  text: string;
}

/**
 * 一个已经解析出的连续字段。
 * offset 与 length 同时驱动字段表格和字节地图高亮。
 */
export interface ParsedField {
  offset: number;
  length: number;
  name: string;
  raw: string;
  value: string;
  unit?: string;
  note?: string;
  tone?: "header" | "meta" | "value" | "check" | "status";
}

/** 大口径水表的一条历史采集记录。 */
export interface HistoryItem {
  collectTime: string;
  forwardFlow?: number;
  reverseFlow?: number;
  instantFlow?: number;
  pressure?: number;
}

/** 所有解析器必须返回的标准结果，界面只依赖该结构。 */
export interface ParseResult {
  protocol: string;
  protocolId: string;
  category: "water" | "electric" | "gateway";
  categoryLabel: string;
  manufacturer: string;
  confidence: number;
  meterNo: string;
  controlCode: string;
  dataIdentifier: string;
  dataLength: number;
  coreValue: string;
  metrics: Record<string, string | number | null>;
  fields: ParsedField[];
  diagnostics: Diagnostic[];
  history: HistoryItem[];
  rawBytes: number[];
}

/** 用户可覆盖的解析参数。 */
export interface ParseOptions {
  intEndian?: "auto" | "be" | "le";
  floatEndian?: "be" | "le";
  century?: string;
}

/**
 * 协议插件接口。
 * 新协议只需实现识别评分 detect 和实际解析 parse，再注册到 registry。
 */
export interface ProtocolParser {
  id: string;
  name: string;
  category: ParseResult["category"];
  status: "ready" | "beta";
  detect(bytes: number[], options?: ParseOptions): number;
  parse(bytes: number[], options?: ParseOptions): ParseResult;
}
