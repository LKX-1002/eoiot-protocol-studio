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

/** 概览区中的单个业务值；由协议解析器决定标签、单位和说明。 */
export interface OverviewItem {
  key: string;
  label: string;
  value: string | number | null;
  unit?: string;
  note?: string;
}

/**
 * 概览区的业务分组。
 * 小口径和大口径返回不同分组，前端无需猜测 metrics 中哪些字段应该展示。
 */
export interface OverviewSection {
  id: string;
  title: string;
  items: OverviewItem[];
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
  overviewSections: OverviewSection[];
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
  /**
   * 在进入业务字段解析前执行严格校验。
   * 结构、长度、边界或校验和错误时必须抛出可直接展示给用户的错误。
   */
  validate(bytes: number[], options?: ParseOptions): void;
  parse(bytes: number[], options?: ParseOptions): ParseResult;
}
