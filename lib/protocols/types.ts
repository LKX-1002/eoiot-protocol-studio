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
  category: "water" | "electric" | "gateway" | "industrial";
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

export type ModbusDataType = "UINT16" | "INT16" | "UINT32" | "INT32" | "FLOAT32";
export type ModbusByteOrder = "AB" | "BA" | "ABCD" | "CDAB" | "BADC" | "DCBA";
export interface ModbusDecodeConfig {
  /** 未设置时兼容旧记录的手动范围；all 按当前应答长度计算全部数据。 */
  rangeMode?: "all" | "custom";
  dataType: ModbusDataType;
  byteOrder: ModbusByteOrder;
  scale: number;
  unit: string;
  /** 相对于应答数据区，从 0 开始的寄存器位置，非实际寄存器地址。 */
  registerOffset: number;
  valueCount: number;
  label: string;
  decimals?: number;
  model?: string;
  /** 从读取请求或厂家文档填写的协议起始地址；应答自身不携带此值。 */
  registerAddress?: number;
}

/** 用户可覆盖的解析参数。 */
export interface ParseOptions {
  modbusDecode?: ModbusDecodeConfig;
  /** RTU 应答不携带寄存器地址，业务解码必须使用显式的设备规则。 */
  modbusProfile?: "uint16-energy" | "raw";
  intEndian?: "auto" | "be" | "le";
  floatEndian?: "be" | "le";
  century?: string;
}

/**
 * 协议插件接口。
 * 每个解析器必须实现 detect、validate、parse，再注册到 registry。
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
