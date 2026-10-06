"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { hex, parseHex } from "@/lib/protocols/bytes";
import { buildAnalysisSummary } from "@/lib/protocols/analysis";
import { parseWithRegistry, parsers, validateWithRegistry } from "@/lib/protocols/registry";
import { sampleList, samples } from "@/lib/protocols/samples";
import { buildWotmanIpCommand } from "@/lib/protocols/wotman-command";
import { buildWotmanSyncCommand } from "@/lib/protocols/wotman-sync-command";
import { buildCollectionIntervalCommand, buildUploadScheduleCommand, buildValveCommand, type ValveAction } from "@/lib/protocols/wotman-control-command";
import { buildJoymeterCommand, type JoymeterCommandKind, type JoymeterValveAction } from "@/lib/protocols/joymeter-command";
import { downloadXlsx } from "@/lib/export-xlsx";
import type { ParseResult, ParsedField } from "@/lib/protocols/types";

type TabId = "overview" | "fields" | "bytes" | "history" | "diagnostics" | "json";
type AppView = "studio" | "commands" | "library" | "samples" | "records";
type CommandType = "network" | "sync" | "valve" | "schedule" | "interval";
type CommandVendor = "wotman" | "joymeter";
type ActionFeedback = "paste" | "format" | "clear" | "copy-json" | "export-json" | "copy-command" | "export-command" | null;
type CommandGenerationMode = "single" | "batch";

const defaultCommandInput = { meterAddress: "00430500003821", primaryIp: "60.205.218.69", primaryPort: "6118", apn: "CMNET" };
const defaultJoymeterInput = { meterAddress: "00510500088954", ip: "60.205.218.69", port: "6118", baseReading: "12345678", valveAction: "open" as JoymeterValveAction, startHour: "3", maxRandomSeconds: "3600", reportPeriodHours: "6" };

const commandProtocols: Array<{ id: CommandVendor; manufacturer: string; product: string; scope: string; keywords: string }> = [
  { id: "wotman", manufacturer: "沃特曼", product: "采集器 / 大口径水表", scope: "NB-IoT 仪表采集器协议", keywords: "沃特曼 水表 采集器 大口径 NB 8110 A016 8104 8105" },
  { id: "joymeter", manufacturer: "Joymeter", product: "后付费 NB & 4G 水表", scope: "CJ/T 188 扩展写入协议", keywords: "Joymeter 4G 后付费 水表 A171 A180 A181 A182 A183 A184" },
];

const commandCatalog: Record<CommandVendor, Array<{ group: string; items: Array<{ id: string; label: string; di: string; keywords: string }> }>> = {
  wotman: [
    { group: "通信配置", items: [{ id: "network", label: "写 IP / 端口", di: "8110H", keywords: "通信 服务器 APN IP 端口" }] },
    { group: "计量设置", items: [{ id: "sync", label: "写机电同步", di: "A016H", keywords: "累计流量 同步 底数" }] },
    { group: "设备控制", items: [{ id: "valve", label: "阀门控制", di: "A017H", keywords: "开阀 关阀" }] },
    { group: "数据采集", items: [{ id: "schedule", label: "自动上传时间", di: "8104H", keywords: "上传 时间 定时" }, { id: "interval", label: "采集间隔", di: "8105H", keywords: "采集 间隔 分钟" }] },
  ],
  joymeter: [
    { group: "通信配置", items: [{ id: "network", label: "写 IP / 端口", di: "A184H", keywords: "通信 UDP 服务器 IP 端口" }] },
    { group: "计量设置", items: [{ id: "base", label: "写基表读数", di: "A171H", keywords: "底数 累计量 读数" }] },
    { group: "设备控制", items: [{ id: "valve", label: "开关阀", di: "A017H", keywords: "开阀 关阀" }] },
    { group: "上报配置", items: [{ id: "reporting", label: "上报参数集合", di: "A180H", keywords: "上报 参数 集合" }, { id: "start", label: "上报起始时间", di: "A181H", keywords: "上报 起始 时间" }, { id: "random", label: "最大随机间隔", di: "A182H", keywords: "上报 随机 间隔 秒" }, { id: "period", label: "上报周期", di: "A183H", keywords: "上报 周期 小时" }] },
  ],
};

/** 工具栏使用统一的线性图标，避免不同平台的 Emoji 造成视觉尺寸不一致。 */
function ToolIcon({ name }: { name: "paste" | "format" | "clear" | "copy" | "download" | "check" | "code" }) {
  const paths = {
    paste: <><path d="M9 5h6"/><path d="M9 3h6v4H9z"/><path d="M7 5H5v16h14V5h-2"/></>,
    format: <><path d="M4 6h16M4 12h10M4 18h7"/><path d="m16 17 2 2 3-4"/></>,
    clear: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
    copy: <><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></>,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    code: <><path d="m9 8-4 4 4 4m6-8 4 4-4 4"/></>,
  };
  return <svg className="tool-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

/**
 * 两色协议窗口：圆点和短线复用底色，深浅主题通过品牌变量同步换色。
 */
function BrandMark() {
  return <svg className="brand-mark" aria-hidden="true" viewBox="0 0 40 40">
    <rect className="brand-logo-card" x="1" y="1" width="38" height="38" rx="10"/>
    <rect className="brand-logo-window" x="9" y="13" width="22" height="16" rx="3.2"/>
    <circle className="brand-logo-cutout" cx="13.6" cy="23.8" r="1.3"/>
    <rect className="brand-logo-cutout" x="17.4" y="22.5" width="10.4" height="2.6" rx="1.3"/>
  </svg>;
}

/** 侧栏导航统一使用 18px 线性 SVG，保证图标线宽、基线和文字间距一致。 */
function NavIcon({ name }: { name: "parser" | "command" | "library" | "sample" | "history" | "device" | "team" }) {
  const paths = {
    parser: <><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5M8 12h8M8 16h5"/></>,
    command: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
    library: <><path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M8 4v16M11 8h5M11 12h5"/></>,
    sample: <><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h3v3H8zM13 8h3v3h-3zM8 13h3v3H8zM13 13h3v3h-3z"/></>,
    history: <><path d="M4 12a8 8 0 1 0 2.34-5.66L4 8.68"/><path d="M4 4v4.68h4.68M12 8v5l3 2"/></>,
    device: <><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9 7h6M9 11h6M10 17h4"/></>,
    team: <><path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M17 11a4 4 0 0 1 4 4v2M17 3.5a4 4 0 0 1 0 7"/></>,
  };
  return <svg className="nav-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

/** 本机解析记录只保存必要摘要与原始报文，最多保留最近 20 条。 */
interface ParseRecord {
  id: string;
  createdAt: string;
  protocol: string;
  coreValue: string;
  meterNo: string;
  raw: string;
}

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "解析概览" },
  { id: "fields", label: "字段解释" },
  { id: "bytes", label: "字节地图" },
  { id: "history", label: "历史数据" },
  { id: "diagnostics", label: "诊断" },
  { id: "json", label: "JSON" },
];

const parserCapabilities: Record<string, string[]> = {
  "joymeter-command": ["A184 写服务器", "A171 写基表读数", "A017 开关阀", "A180–A183 上报参数", "24H 下行 / A4H 应答", "字段反向解析"],
  "wotman-command": ["8110 写通信参数", "A016 写机电同步", "A017 阀门控制", "8104 上传时间", "8105 采集间隔", "字段反向解析"],
  "cjt188-small": ["10H 冷水", "11H 生活热水", "12H 直饮水", "13H 中水", "14H–19H 保留", "CS 校验"],
  "wotman-big": ["9021 / 9023 / 9025", "历史数据", "压力温度", "设备身份", "业务告警"],
};

function formatMetric(value: string | number | null, unit?: string) {
  if (value === null || value === "—") return "—";
  const formatted = typeof value === "number" ? value.toLocaleString("zh-CN", { maximumFractionDigits: 3 }) : value;
  return unit ? `${formatted} ${unit}` : formatted;
}

/** 复用字段解释的标准五列表格，保持基础字段和后续设备字段列宽一致。 */
function FieldTable({ fields, selectedField, onSelect }: { fields: ParsedField[]; selectedField: ParsedField | null; onSelect: (field: ParsedField) => void }) {
  return <div className="table-scroll field-table-scroll"><table className="field-table"><colgroup><col className="field-col-offset" /><col className="field-col-name" /><col className="field-col-raw" /><col className="field-col-value" /><col className="field-col-note" /></colgroup><thead><tr><th>偏移</th><th>字段</th><th>原始字节</th><th>解析值</th><th>说明</th></tr></thead><tbody>{fields.map((item) => <tr className={selectedField === item ? "is-selected" : ""} key={`${item.offset}-${item.name}`} onMouseEnter={() => onSelect(item)} onClick={() => onSelect(item)}><td>{item.offset}–{item.offset + Math.max(item.length - 1, 0)}</td><td>{item.name}</td><td><code>{item.raw || "—"}</code></td><td><strong>{item.value}</strong>{item.unit ? ` ${item.unit}` : ""}</td><td>{item.note ?? "—"}</td></tr>)}</tbody></table></div>;
}

/**
 * 长报文按“报文结构 / 历史记录 / 当前与设备”分区浏览。
 * 历史记录采用记录选择器与单条详情，避免 12 条记录全部纵向展开。
 */
function FieldExplanation({ result, selectedField, onSelect }: { result: ParseResult; selectedField: ParsedField | null; onSelect: (field: ParsedField) => void }) {
  const [section, setSection] = useState<"structure" | "history" | "current">("structure");
  const [activeRecord, setActiveRecord] = useState(1);
  const [currentGroup, setCurrentGroup] = useState<"measurement" | "network" | "status">("measurement");
  const historyPattern = /^历史第\s+(\d+)\s+条/;
  const historyIndexes = result.fields
    .map((item, index) => historyPattern.test(item.name) ? index : -1)
    .filter((index) => index >= 0);
  if (!historyIndexes.length) return <FieldTable fields={result.fields} selectedField={selectedField} onSelect={onSelect}/>;

  const firstHistoryIndex = historyIndexes[0];
  const lastHistoryIndex = historyIndexes.at(-1) ?? firstHistoryIndex;
  const beforeHistory = result.fields.slice(0, firstHistoryIndex);
  const afterHistory = result.fields.slice(lastHistoryIndex + 1);
  const grouped = new Map<number, ParsedField[]>();
  result.fields.slice(firstHistoryIndex, lastHistoryIndex + 1).forEach((item) => {
    const recordNumber = Number(item.name.match(historyPattern)?.[1]);
    if (!Number.isFinite(recordNumber)) return;
    grouped.set(recordNumber, [...(grouped.get(recordNumber) ?? []), item]);
  });
  const groups = [...grouped.entries()].sort(([left], [right]) => left - right);
  const bytesPerRecord = groups[0]?.[1].reduce((sum, item) => sum + item.length, 0) ?? 0;
  const is9025 = result.dataIdentifier === "9025";
  const selectedHistory = groups.find(([recordNumber]) => recordNumber === activeRecord) ?? groups[0];
  const selectedHistoryItem = selectedHistory ? result.history[selectedHistory[0] - 1] : undefined;
  const networkPattern = /信号|覆盖|PCI|IMEI|IMSI/i;
  const measurementPattern = /当前|电压/;
  const currentGroups = {
    measurement: afterHistory.filter((item) => measurementPattern.test(item.name) && !networkPattern.test(item.name)),
    network: afterHistory.filter((item) => networkPattern.test(item.name)),
    status: afterHistory.filter((item) => !measurementPattern.test(item.name) && !networkPattern.test(item.name)),
  };
  const currentOptions = [
    { id: "measurement" as const, label: "当前计量", fields: currentGroups.measurement },
    { id: "network" as const, label: "网络身份", fields: currentGroups.network },
    { id: "status" as const, label: "状态校验", fields: currentGroups.status },
  ].filter((item) => item.fields.length > 0);
  const activeCurrent = currentOptions.find((item) => item.id === currentGroup) ?? currentOptions[0];
  const historyFieldLabel = (name: string) => name.replace(/^历史第\s+\d+\s+条[·：:\s]*/, "");

  return <div className="field-explanation">
    <div className="field-section-tabs" role="tablist" aria-label="字段解释分区">
      <button className={section === "structure" ? "active" : ""} type="button" role="tab" aria-selected={section === "structure"} onClick={() => setSection("structure")}><span>报文结构</span><em>{beforeHistory.length}</em></button>
      <button className={section === "history" ? "active" : ""} type="button" role="tab" aria-selected={section === "history"} onClick={() => setSection("history")}><span>历史记录</span><em>{groups.length}</em></button>
      {afterHistory.length > 0 && <button className={section === "current" ? "active" : ""} type="button" role="tab" aria-selected={section === "current"} onClick={() => setSection("current")}><span>当前与设备</span><em>{afterHistory.length}</em></button>}
    </div>

    {section === "structure" && <FieldTable fields={beforeHistory} selectedField={selectedField} onSelect={onSelect}/>}

    {section === "history" && selectedHistory && <section className="history-browser" aria-label="历史采集记录">
      <header><div><strong>历史采集记录</strong><span>{is9025 ? "选择一条记录查看 A / B / C / D 四项明细" : `${result.dataIdentifier} 每条为一个采集时点累计量`}</span></div><em>{groups.length} 条 · {bytesPerRecord} Bytes / 条</em></header>
      <div className="history-record-picker" role="list" aria-label="选择历史记录">{groups.map(([recordNumber, fields]) => {
        const historyItem = result.history[recordNumber - 1];
        const primaryField = fields.find((item) => item.name.includes("正向累计")) ?? fields[0];
        const displayTime = historyItem?.collectTime?.split(" ").at(-1) ?? "—";
        return <button className={selectedHistory[0] === recordNumber ? "active" : ""} key={recordNumber} type="button" role="listitem" onClick={() => { setActiveRecord(recordNumber); onSelect(primaryField); }}><span>第 {recordNumber} 条</span><strong>{displayTime}</strong><small>{primaryField.value}{primaryField.unit ? ` ${primaryField.unit}` : ""}</small></button>;
      })}</div>
      <article className="history-record-detail">
        <header><div><strong>第 {selectedHistory[0]} 条详情</strong><span>{selectedHistoryItem?.collectTime ?? "采集时间未提供"}</span></div><code>偏移 {selectedHistory[1][0].offset}–{(selectedHistory[1].at(-1) ?? selectedHistory[1][0]).offset + (selectedHistory[1].at(-1) ?? selectedHistory[1][0]).length - 1}</code></header>
        <div className="history-detail-grid">{selectedHistory[1].map((item) => <button className={selectedField === item ? "is-selected" : ""} key={`${item.offset}-${item.name}`} type="button" onMouseEnter={() => onSelect(item)} onFocus={() => onSelect(item)} onClick={() => onSelect(item)}><span>{historyFieldLabel(item.name)}</span><strong>{item.value}{item.unit ? ` ${item.unit}` : ""}</strong><code>{item.raw}</code></button>)}</div>
      </article>
    </section>}

    {section === "current" && activeCurrent && <section className="current-field-browser">
      <div className="current-field-tabs" role="tablist" aria-label="当前值与设备字段分组">{currentOptions.map((item) => <button className={activeCurrent.id === item.id ? "active" : ""} type="button" role="tab" aria-selected={activeCurrent.id === item.id} key={item.id} onClick={() => setCurrentGroup(item.id)}>{item.label}<em>{item.fields.length}</em></button>)}</div>
      <FieldTable fields={activeCurrent.fields} selectedField={selectedField} onSelect={onSelect}/>
    </section>}
  </div>;
}

function initialResult(): ParseResult | null {
  try { return parseWithRegistry(parseHex(samples.cjt188.value)); } catch { return null; }
}

/** 字节地图与字段表共享选中状态，便于从业务字段反查原始报文。 */
function ByteMap({ result, selectedField, onSelect }: { result: ParseResult; selectedField: ParsedField | null; onSelect: (field: ParsedField | null) => void }) {
  const [hoveredByte, setHoveredByte] = useState<{ index: number; x: number; y: number } | null>(null);
  const ownerAt = (index: number) => result.fields.find((item) => index >= item.offset && index < item.offset + item.length);
  const hoveredOwner = hoveredByte ? ownerAt(hoveredByte.index) : null;
  const showByteTooltip = (element: HTMLButtonElement, index: number) => {
    const rect = element.getBoundingClientRect();
    const safeX = Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150);
    setHoveredByte({ index, x: safeX, y: rect.top });
  };
  return <div className="byte-map-wrap">
    <div className="byte-map" aria-label="HEX 字节地图">{result.rawBytes.map((value, index) => {
      const owner = ownerAt(index);
      const selected = selectedField && index >= selectedField.offset && index < selectedField.offset + selectedField.length;
      return <button aria-label={`偏移 ${index}，字节 ${hex([value])}${owner ? `，${owner.name}` : "，未归属字段"}`} className={`byte-chip tone-${owner?.tone ?? "plain"}${selected ? " is-selected" : ""}`} key={`${index}-${value}`} type="button" onMouseEnter={(event) => { onSelect(owner ?? null); showByteTooltip(event.currentTarget, index); }} onMouseLeave={() => setHoveredByte(null)} onFocus={(event) => { onSelect(owner ?? null); showByteTooltip(event.currentTarget, index); }} onBlur={() => setHoveredByte(null)}>
        <small>{index.toString(16).padStart(2, "0").toUpperCase()}</small>{hex([value])}
      </button>;
    })}</div>
    {hoveredByte && <div className="byte-hover-card" role="tooltip" style={{ left: hoveredByte.x, top: hoveredByte.y }}><header><strong>{hoveredOwner?.name ?? "未归属字段"}</strong><code>偏移 {hoveredByte.index} · {hex([result.rawBytes[hoveredByte.index]])}</code></header>{hoveredOwner && <><p><span>解析值</span><strong>{hoveredOwner.value}{hoveredOwner.unit ? ` ${hoveredOwner.unit}` : ""}</strong></p><small>{hoveredOwner.note ?? `字段范围 ${hoveredOwner.offset}–${hoveredOwner.offset + hoveredOwner.length - 1}`}</small></>}</div>}
    <div className="byte-selection">{selectedField ? <><strong>{selectedField.name}</strong><span>偏移 {selectedField.offset} · {selectedField.length} Bytes · {selectedField.value}{selectedField.unit ? ` ${selectedField.unit}` : ""}</span></> : <span>悬停或聚焦字节，查看所属字段和偏移。</span>}</div>
  </div>;
}

export function ProtocolStudio() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [view, setView] = useState<AppView>("studio");
  const [rawInput, setRawInput] = useState(samples.cjt188.value);
  const [commandInput, setCommandInput] = useState({ ...defaultCommandInput });
  const [commandVendor, setCommandVendor] = useState<CommandVendor>("wotman");
  const [commandType, setCommandType] = useState<CommandType>("network");
  const [joymeterCommandType, setJoymeterCommandType] = useState<JoymeterCommandKind>("network");
  const [joymeterInput, setJoymeterInput] = useState({ ...defaultJoymeterInput });
  const [protocolPickerOpen, setProtocolPickerOpen] = useState(false);
  const [protocolSearch, setProtocolSearch] = useState("");
  const [commandSearch, setCommandSearch] = useState("");
  const [commandGenerationMode, setCommandGenerationMode] = useState<CommandGenerationMode>("single");
  const [batchMeterInput, setBatchMeterInput] = useState("");
  const [syncCommandInput, setSyncCommandInput] = useState({ meterAddress: "00430500003931", cumulativeFlow: "10" });
  const [valveCommandInput, setValveCommandInput] = useState<{ meterAddress: string; action: ValveAction }>({ meterAddress: "00430500003931", action: "open" });
  const [scheduleMeterAddress, setScheduleMeterAddress] = useState("00430500003931");
  const [uploadSchedule, setUploadSchedule] = useState<Array<[string, string]>>(() => Array.from({ length: 24 }, () => ["0", "30"]));
  const [intervalCommandInput, setIntervalCommandInput] = useState({ meterAddress: "00430500003931", intervalMinutes: "60" });
  const [result, setResult] = useState<ParseResult | null>(initialResult);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [selectedField, setSelectedField] = useState<ParsedField | null>(null);
  const [records, setRecords] = useState<ParseRecord[]>([]);
  const [message, setMessage] = useState("已载入示例，可直接体验解析结果");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rawInputRef = useRef<HTMLTextAreaElement>(null);

  /** 恢复主题与本机记录；数据不会离开当前浏览器。 */
  useEffect(() => {
    const savedTheme = window.localStorage.getItem("eoiot-theme");
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme);
    try { setRecords(JSON.parse(window.localStorage.getItem("eoiot-records") ?? "[]")); } catch { setRecords([]); }
  }, []);

  /** Toast 只用于确认复制、导入等轻量操作。 */
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** 按钮内的成功反馈保持 1.4 秒，然后自动恢复为原操作名称。 */
  useEffect(() => {
    if (!actionFeedback) return;
    const timer = window.setTimeout(() => setActionFeedback(null), 1400);
    return () => window.clearTimeout(timer);
  }, [actionFeedback]);

  /**
   * 输入框根据报文内容自动增高：短帧保持紧凑，长帧达到上限后内部滚动。
   * 这里读取真实 scrollHeight，因此不会再按固定字节数提前换行或留下大块空白。
   */
  useLayoutEffect(() => {
    const editor = rawInputRef.current;
    if (!editor) return;
    const fitEditorToContent = () => {
      const compact = window.matchMedia("(max-width: 760px)").matches;
      const minHeight = compact ? 156 : 168;
      const maxHeight = compact ? 260 : 360;
      editor.style.height = "0px";
      const contentHeight = editor.scrollHeight;
      const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);
      editor.style.height = `${nextHeight}px`;
      editor.style.overflowY = contentHeight > nextHeight ? "auto" : "hidden";
    };
    fitEditorToContent();
    window.addEventListener("resize", fitEditorToContent);
    return () => window.removeEventListener("resize", fitEditorToContent);
  }, [rawInput]);

  const inputState = useMemo(() => {
    try {
      const bytes = parseHex(rawInput);
      if (!bytes.length) return { valid: true, count: 0, text: "等待输入" };
      // 前端只提供一个 HEX 入口；协议注册中心根据帧长度结构自动选择解析器。
      validateWithRegistry(bytes);
      return { valid: true, count: bytes.length, text: "格式与帧校验通过" };
    } catch (caught) {
      let count = 0;
      try { count = parseHex(rawInput).length; } catch { /* 非法 HEX 无法可靠计算字节数。 */ }
      return { valid: false, count, text: caught instanceof Error ? caught.message : "HEX 或帧结构错误" };
    }
  }, [rawInput]);

  /** 解析结果变化时同步生成本地规则结论，不上传设备报文。 */
  const analysis = useMemo(() => result ? buildAnalysisSummary(result) : null, [result]);

  /** 写参数指令随输入实时生成；错误只显示在组帧页，不影响协议解析工作台。 */
  const commandPreview = useMemo(() => {
    try { return { result: buildWotmanIpCommand(commandInput), error: "" }; }
    catch (caught) { return { result: null, error: caught instanceof Error ? caught.message : "指令参数不正确。" }; }
  }, [commandInput]);

  const syncCommandPreview = useMemo(() => {
    try { return { result: buildWotmanSyncCommand(syncCommandInput), error: "" }; }
    catch (caught) { return { result: null, error: caught instanceof Error ? caught.message : "机电同步参数不正确。" }; }
  }, [syncCommandInput]);

  const valveCommandPreview = useMemo(() => {
    try { return { result: buildValveCommand(valveCommandInput), error: "" }; }
    catch (caught) { return { result: null, error: caught instanceof Error ? caught.message : "阀门控制参数不正确。" }; }
  }, [valveCommandInput]);

  const scheduleCommandPreview = useMemo(() => {
    try {
      const schedule = uploadSchedule.map(([first, second]) => [first.trim() === "" ? null : Number(first), second.trim() === "" ? null : Number(second)] as [number | null, number | null]);
      return { result: buildUploadScheduleCommand({ meterAddress: scheduleMeterAddress, schedule }), error: "" };
    } catch (caught) { return { result: null, error: caught instanceof Error ? caught.message : "自动上传时间参数不正确。" }; }
  }, [scheduleMeterAddress, uploadSchedule]);

  const intervalCommandPreview = useMemo(() => {
    try { return { result: buildCollectionIntervalCommand(intervalCommandInput), error: "" }; }
    catch (caught) { return { result: null, error: caught instanceof Error ? caught.message : "采集间隔参数不正确。" }; }
  }, [intervalCommandInput]);

  const joymeterCommandPreview = useMemo(() => {
    try { return { result: buildJoymeterCommand({ kind: joymeterCommandType, ...joymeterInput }), error: "" }; }
    catch (caught) { return { result: null, error: caught instanceof Error ? caught.message : "Joymeter 指令参数不正确。" }; }
  }, [joymeterCommandType, joymeterInput]);

  const activeCommandPreview = commandVendor === "joymeter" ? joymeterCommandPreview : commandType === "network" ? commandPreview
    : commandType === "sync" ? syncCommandPreview
      : commandType === "valve" ? valveCommandPreview
        : commandType === "schedule" ? scheduleCommandPreview
          : intervalCommandPreview;
  const joymeterPresentation = joymeterCommandType === "network"
    ? { formTitle: "填写服务器参数", primaryLabel: "Joymeter 服务器", primaryValue: `${joymeterInput.ip}:${joymeterInput.port}`, secondaryLabel: "通信协议", secondaryValue: "UDP · 01H", outputHint: "A184H 数据域共 10 Bytes，可直接复制下发", copyLabel: "Joymeter 写服务器指令", fieldHint: "IP 按网络顺序，端口按小端顺序" }
    : joymeterCommandType === "base"
      ? { formTitle: "填写基表读数", primaryLabel: "写入目标", primaryValue: joymeterInput.meterAddress.padStart(14, "0"), secondaryLabel: "基表读数", secondaryValue: `${joymeterInput.baseReading || "—"} L`, outputHint: "A171H 数据域共 8 Bytes，可直接复制下发", copyLabel: "Joymeter 写基表读数指令", fieldHint: "读数使用 4 字节 BCD、小端，末尾固定 00H" }
      : joymeterCommandType === "valve"
        ? { formTitle: "填写阀门参数", primaryLabel: "控制目标", primaryValue: joymeterInput.meterAddress.padStart(14, "0"), secondaryLabel: "阀门操作", secondaryValue: joymeterInput.valveAction === "open" ? "开阀 · 55H" : "关阀 · 99H", outputHint: "A017H 数据域共 4 Bytes，可直接复制下发", copyLabel: "Joymeter 开关阀指令", fieldHint: "55H 表示开阀，99H 表示关阀" }
        : joymeterCommandType === "reporting"
          ? { formTitle: "填写上报参数", primaryLabel: "写入目标", primaryValue: joymeterInput.meterAddress.padStart(14, "0"), secondaryLabel: "上报方案", secondaryValue: `${joymeterInput.startHour || "—"} 点 / ${joymeterInput.maxRandomSeconds || "—"} 秒 / ${joymeterInput.reportPeriodHours || "—"} 小时`, outputHint: "A180H 一次写入起始时间、随机间隔与周期", copyLabel: "Joymeter 写上报参数集合指令", fieldHint: "起始小时为 BCD；随机间隔为 2 字节小端" }
          : joymeterCommandType === "start"
            ? { formTitle: "设置上报起始时间", primaryLabel: "写入目标", primaryValue: joymeterInput.meterAddress.padStart(14, "0"), secondaryLabel: "起始时间", secondaryValue: `${joymeterInput.startHour || "—"} 点`, outputHint: "A181H 数据域共 4 Bytes", copyLabel: "Joymeter 写上报起始时间指令", fieldHint: "0–23 点，按 1 字节 BCD 编码" }
            : joymeterCommandType === "random"
              ? { formTitle: "设置最大随机间隔", primaryLabel: "写入目标", primaryValue: joymeterInput.meterAddress.padStart(14, "0"), secondaryLabel: "最大随机间隔", secondaryValue: `${joymeterInput.maxRandomSeconds || "—"} 秒`, outputHint: "A182H 数据域共 5 Bytes", copyLabel: "Joymeter 写最大随机间隔指令", fieldHint: "2 字节无符号整数、小端；不得小于 10 秒" }
              : { formTitle: "设置上报周期", primaryLabel: "写入目标", primaryValue: joymeterInput.meterAddress.padStart(14, "0"), secondaryLabel: "上报周期", secondaryValue: `${joymeterInput.reportPeriodHours || "—"} 小时`, outputHint: "A183H 数据域共 4 Bytes", copyLabel: "Joymeter 写上报周期指令", fieldHint: "1 字节无符号整数，单位小时" };
  const activeCommandPresentation = commandVendor === "joymeter" ? joymeterPresentation : commandType === "network"
    ? { formTitle: "填写通信参数", primaryLabel: "主用服务器", primaryValue: `${commandInput.primaryIp}:${commandInput.primaryPort}`, secondaryLabel: "数据区 / 整帧", secondaryValue: `59 / ${activeCommandPreview.result?.bytes.length ?? 0} Bytes`, outputHint: "DI 至 MAC 末字节共 59 Bytes，可直接复制下发", copyLabel: "沃特曼写参数指令", fieldHint: "IP 按网络顺序，端口按小端顺序" }
    : commandType === "sync"
      ? { formTitle: "填写同步参数", primaryLabel: "同步目标", primaryValue: syncCommandInput.meterAddress.padStart(14, "0"), secondaryLabel: "累计流量", secondaryValue: `${syncCommandInput.cumulativeFlow || "—"} m³`, outputHint: "DI 至单位字节共 8 Bytes，可直接复制下发", copyLabel: "沃特曼写机电同步指令", fieldHint: "累计量为 4 字节 BCD、小端，2CH 表示 0.01 m³/计数" }
      : commandType === "valve"
        ? { formTitle: "填写阀门参数", primaryLabel: "控制目标", primaryValue: valveCommandInput.meterAddress.padStart(14, "0"), secondaryLabel: "阀门操作", secondaryValue: valveCommandInput.action === "open" ? "开阀 · 55H" : "关阀 · 99H", outputHint: "A017H 数据区共 4 Bytes，可直接复制下发", copyLabel: "沃特曼阀门控制指令", fieldHint: "55H 表示开阀，99H 表示关阀" }
        : commandType === "schedule"
          ? { formTitle: "设置上传时间", primaryLabel: "设置目标", primaryValue: scheduleMeterAddress.padStart(14, "0"), secondaryLabel: "启用时刻", secondaryValue: `${scheduleCommandPreview.result?.enabledCount ?? 0} 个`, outputHint: "8104H 数据区共 51 Bytes，包含 24×2 个分钟值", copyLabel: "沃特曼自动上传时间指令", fieldHint: "每小时两个 1 字节分钟值，留空编码为 FFH" }
          : { formTitle: "设置采集间隔", primaryLabel: "设置目标", primaryValue: intervalCommandInput.meterAddress.padStart(14, "0"), secondaryLabel: "采集间隔", secondaryValue: `${intervalCommandInput.intervalMinutes || "—"} 分钟`, outputHint: "8105H 数据区共 4 Bytes，可直接复制下发", copyLabel: "沃特曼采集间隔指令", fieldHint: "间隔时间使用 1 字节无符号整数" };

  const activeMeterAddress = commandVendor === "joymeter" ? joymeterInput.meterAddress : commandType === "network" ? commandInput.meterAddress
    : commandType === "sync" ? syncCommandInput.meterAddress
      : commandType === "valve" ? valveCommandInput.meterAddress
        : commandType === "schedule" ? scheduleMeterAddress
          : intervalCommandInput.meterAddress;

  const currentProtocol = commandProtocols.find((item) => item.id === commandVendor)!;
  const currentCommandId = commandVendor === "joymeter" ? joymeterCommandType : commandType;
  const filteredProtocols = commandProtocols.filter((item) => `${item.manufacturer} ${item.product} ${item.scope} ${item.keywords}`.toLowerCase().includes(protocolSearch.trim().toLowerCase()));
  const visibleCommandGroups = commandCatalog[commandVendor].map((group) => ({
    ...group,
    items: group.items.filter((item) => `${item.label} ${item.di} ${item.keywords}`.toLowerCase().includes(commandSearch.trim().toLowerCase())),
  })).filter((group) => group.items.length);
  const selectCommand = (id: string) => {
    if (commandVendor === "joymeter") setJoymeterCommandType(id as JoymeterCommandKind);
    else setCommandType(id as CommandType);
    setSelectedField(null);
  };
  const selectCommandProtocol = (id: CommandVendor) => {
    setCommandVendor(id);
    setProtocolPickerOpen(false);
    setProtocolSearch("");
    setCommandSearch("");
    setSelectedField(null);
  };

  const batchMeterState = useMemo(() => {
    const tokens = batchMeterInput.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);
    const seen = new Set<string>();
    const unique: Array<{ value: string; valid: boolean }> = [];
    let duplicateCount = 0;
    for (const item of tokens) {
      const valid = /^\d{1,14}$/.test(item);
      const value = valid ? item.padStart(14, "0") : item;
      const key = `${valid ? "valid" : "invalid"}:${value}`;
      if (seen.has(key)) { duplicateCount += 1; continue; }
      seen.add(key);
      unique.push({ value, valid });
    }
    const limited = unique.slice(0, 500);
    return {
      valid: limited.filter((item) => item.valid).map((item) => item.value),
      invalid: limited.filter((item) => !item.valid).map((item) => item.value),
      duplicateCount,
      overflowCount: Math.max(unique.length - limited.length, 0),
    };
  }, [batchMeterInput]);

  const batchCommandRows = useMemo(() => batchMeterState.valid.map((meterAddress) => {
    try {
      const result = commandVendor === "joymeter" ? buildJoymeterCommand({ kind: joymeterCommandType, ...joymeterInput, meterAddress })
        : commandType === "network" ? buildWotmanIpCommand({ ...commandInput, meterAddress })
        : commandType === "sync" ? buildWotmanSyncCommand({ ...syncCommandInput, meterAddress })
          : commandType === "valve" ? buildValveCommand({ ...valveCommandInput, meterAddress })
            : commandType === "schedule" ? buildUploadScheduleCommand({ meterAddress, schedule: uploadSchedule.map(([first, second]) => [first.trim() === "" ? null : Number(first), second.trim() === "" ? null : Number(second)] as [number | null, number | null]) })
              : buildCollectionIntervalCommand({ ...intervalCommandInput, meterAddress });
      return { meterAddress: meterAddress.padStart(14, "0"), result, error: "" };
    } catch (caught) {
      return { meterAddress: meterAddress.padStart(14, "0"), result: null, error: caught instanceof Error ? caught.message : "组帧失败" };
    }
  }), [batchMeterState.valid, commandInput, commandType, commandVendor, intervalCommandInput, joymeterCommandType, joymeterInput, syncCommandInput, uploadSchedule, valveCommandInput]);

  const joymeterMetadata: Record<JoymeterCommandKind, { label: string; di: string; summary: string }> = {
    network: { label: "写服务器 IP / 端口", di: "A184H", summary: `${joymeterInput.ip}:${joymeterInput.port} · UDP` },
    base: { label: "写基表读数", di: "A171H", summary: `${joymeterInput.baseReading || "—"} L` },
    valve: { label: "开关阀", di: "A017H", summary: joymeterInput.valveAction === "open" ? "开阀 · 55H" : "关阀 · 99H" },
    reporting: { label: "写上报参数集合", di: "A180H", summary: `${joymeterInput.startHour} 点 · ${joymeterInput.maxRandomSeconds} 秒 · ${joymeterInput.reportPeriodHours} 小时` },
    start: { label: "写上报起始时间", di: "A181H", summary: `${joymeterInput.startHour || "—"} 点` },
    random: { label: "写最大随机间隔", di: "A182H", summary: `${joymeterInput.maxRandomSeconds || "—"} 秒` },
    period: { label: "写上报周期", di: "A183H", summary: `${joymeterInput.reportPeriodHours || "—"} 小时` },
  };
  const commandMetadata = commandVendor === "joymeter" ? joymeterMetadata[joymeterCommandType] : commandType === "network" ? { label: "写 IP / 端口", di: "8110H", summary: `${commandInput.primaryIp}:${commandInput.primaryPort} · APN ${commandInput.apn}` }
    : commandType === "sync" ? { label: "写机电同步", di: "A016H", summary: `累计流量 ${syncCommandInput.cumulativeFlow || "—"} m³` }
      : commandType === "valve" ? { label: "阀门控制", di: "A017H", summary: valveCommandInput.action === "open" ? "开阀 · 55H" : "关阀 · 99H" }
        : commandType === "schedule" ? { label: "上传时间", di: "8104H", summary: `${scheduleCommandPreview.result?.enabledCount ?? 0} 个上传时刻` }
          : { label: "采集间隔", di: "8105H", summary: `${intervalCommandInput.intervalMinutes || "—"} 分钟` };
  const batchBuildErrors = batchCommandRows.filter((row) => !row.result);
  const batchReady = batchCommandRows.length > 0 && batchMeterState.invalid.length === 0 && batchMeterState.overflowCount === 0 && batchBuildErrors.length === 0;

  const exportBatchCommands = () => {
    if (!batchReady) return;
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    downloadXlsx({
      filename: `${commandVendor === "joymeter" ? "Joymeter" : "沃特曼"}批量指令_${commandMetadata.di.replace("H", "")}_${stamp}.xlsx`,
      sheetName: "批量指令",
      columns: [
        { title: "序号", width: 8 }, { title: "表号", width: 20 }, { title: "指令类型", width: 18 }, { title: "数据标识 DI", width: 15 },
        { title: "参数摘要", width: 34, wrap: true }, { title: "完整 HEX 指令", width: 95, wrap: true }, { title: "字节数", width: 12 }, { title: "校验码 CS", width: 14 },
      ],
      rows: batchCommandRows.map((row, index) => [String(index + 1), row.meterAddress, commandMetadata.label, commandMetadata.di, commandMetadata.summary, row.result!.compactHex, String(row.result!.bytes.length), row.result!.checksum]),
    });
    setActionFeedback("export-command");
    setToast(`已导出 ${batchCommandRows.length} 条批量指令`);
  };

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    window.localStorage.setItem("eoiot-theme", next);
  };

  /** 成功解析后写入有限的本机历史，重复报文仍保留不同调试时刻。 */
  const remember = (parsed: ParseResult, normalized: string) => {
    const record: ParseRecord = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: new Date().toISOString(), protocol: parsed.protocol, coreValue: parsed.coreValue, meterNo: parsed.meterNo, raw: normalized };
    setRecords((current) => {
      const next = [record, ...current].slice(0, 20);
      window.localStorage.setItem("eoiot-records", JSON.stringify(next));
      return next;
    });
  };

  const parseFrame = () => {
    try {
      const bytes = parseHex(rawInput);
      const parsed = parseWithRegistry(bytes);
      const normalized = hex(bytes);
      setRawInput(normalized);
      setResult(parsed);
      setSelectedField(null);
      setActiveTab("overview");
      setError("");
      setMessage(`${parsed.protocol} · 本地解析成功`);
      remember(parsed, normalized);
    } catch (caught) {
      setResult(null);
      setMessage("报文校验失败");
      setError(caught instanceof Error ? caught.message : "解析失败，请检查报文。");
    }
  };

  /** 从样例页载入时立即解析，让用户一步回到完整结果态。 */
  const useSample = (sample: (typeof sampleList)[number]) => {
    setRawInput(sample.value);
    setView("studio");
    try {
      const parsed = parseWithRegistry(parseHex(sample.value));
      setResult(parsed);
      setActiveTab("overview");
      setError("");
      setMessage(`已载入 ${sample.name}`);
    } catch { setMessage("样例已载入，请手动解析"); }
  };

  const formatInput = () => {
    try { setRawInput(hex(parseHex(rawInput))); setError(""); setActionFeedback("format"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "无法格式化当前内容。"); }
  };

  const copyText = async (text: string, label: string, feedback?: ActionFeedback) => {
    try { await navigator.clipboard.writeText(text); if (feedback) setActionFeedback(feedback); else setToast(`${label}已复制`); }
    catch { setError("浏览器未授予剪贴板权限，请手动复制。"); }
  };

  const pasteFrame = async () => {
    try {
      setRawInput(await navigator.clipboard.readText());
      setResult(null);
      setSelectedField(null);
      setMessage("已粘贴新报文，等待解析");
      setError("");
      setActionFeedback("paste");
    }
    catch { setError("浏览器未授予剪贴板读取权限，请使用 Ctrl+V。"); }
  };

  /** 清空编辑器及旧结果，并在按钮本身显示明确反馈。 */
  const clearFrame = () => {
    setRawInput("");
    setResult(null);
    setError("");
    setSelectedField(null);
    setMessage("等待输入新的数据帧");
    setActionFeedback("clear");
  };

  const importText = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setRawInput(String(reader.result ?? "")); setView("studio"); setToast(`已导入 ${file.name}`); };
    reader.onerror = () => setError("文件读取失败，请确认它是文本格式。");
    reader.readAsText(file);
    event.target.value = "";
  };

  const exportJson = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `eoiot-${result.dataIdentifier || "result"}.json`; anchor.click();
    URL.revokeObjectURL(url); setActionFeedback("export-json");
  };

  const reuseRecord = (record: ParseRecord) => { setRawInput(record.raw); setView("studio"); setMessage("已恢复历史报文，按 Ctrl + Enter 重新解析"); };
  const clearRecords = () => { setRecords([]); window.localStorage.removeItem("eoiot-records"); setToast("本机记录已清空"); };

  const renderMeterAddressField = (label: string, value: string, onChange: (value: string) => void, note: string) => commandGenerationMode === "batch"
    ? <label className="batch-meter-field"><span>批量表号</span><textarea value={batchMeterInput} onChange={(event) => setBatchMeterInput(event.target.value)} placeholder={"每行一个表号，也支持空格、逗号分隔\n例如：\n00430500003931\n00430500003932"}/><small>最多 500 个，重复表号会自动去除；导出的 Excel 会把表号保存为文本。</small><div className="batch-meter-stats"><strong>{batchMeterState.valid.length} 个有效</strong>{batchMeterState.invalid.length > 0 && <span className="invalid">{batchMeterState.invalid.length} 个格式错误</span>}{batchMeterState.duplicateCount > 0 && <span>{batchMeterState.duplicateCount} 个重复已忽略</span>}{batchMeterState.overflowCount > 0 && <span className="invalid">超出上限 {batchMeterState.overflowCount} 个</span>}</div>{batchMeterState.invalid.length > 0 && <code className="batch-invalid-list">错误：{batchMeterState.invalid.slice(0, 5).join("、")}{batchMeterState.invalid.length > 5 ? "…" : ""}</code>}</label>
    : <label><span>{label}</span><input value={value} inputMode="numeric" maxLength={14} onChange={(event) => onChange(event.target.value)}/><small>{note}</small></label>;

  return <main className="studio-app" data-theme={theme} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); parseFrame(); } }}>
    <header className="topbar">
      <button className="brand brand-button" type="button" onClick={() => setView("studio")} aria-label="返回协议解析工作台"><BrandMark/><span><strong>EOIOT</strong><small>Protocol Studio</small></span></button>
      <div className="workspace-switch"><strong>源一物联</strong><span>/ 协议研发空间</span></div>
      <span className="version-pill">V2 Preview</span>
      <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}><span>{theme === "light" ? "◐" : "☀"}</span>{theme === "light" ? "切换深色" : "切换浅色"}</button>
    </header>

    <div className="app-grid">
      <aside className="sidebar"><nav aria-label="主导航">
        <p className="nav-title">工作台</p>
        <button className={`nav-item${view === "studio" ? " active" : ""}`} type="button" onClick={() => setView("studio")}><NavIcon name="parser"/><b>协议解析</b></button>
        <button className={`nav-item${view === "commands" ? " active" : ""}`} type="button" onClick={() => setView("commands")}><NavIcon name="command"/><b>指令生成</b></button>
        <button className={`nav-item${view === "library" ? " active" : ""}`} type="button" onClick={() => setView("library")}><NavIcon name="library"/><b>协议库</b></button>
        <button className={`nav-item${view === "samples" ? " active" : ""}`} type="button" onClick={() => setView("samples")}><NavIcon name="sample"/><b>样例帧</b></button>
        <button className={`nav-item${view === "records" ? " active" : ""}`} type="button" onClick={() => setView("records")}><NavIcon name="history"/><b>解析记录</b></button>
        <p className="nav-title">云端能力</p>
        <button className="nav-item is-disabled" type="button" disabled><NavIcon name="device"/><b>设备与上报</b><em>规划中</em></button>
        <button className="nav-item is-disabled" type="button" disabled><NavIcon name="team"/><b>团队协作</b><em>规划中</em></button>
      </nav><div className="local-note"><span className="secure-dot"/><strong>隐私安全</strong><p>解析与记录仅保存在本机</p></div></aside>

      {view === "studio" && <section className="page studio-page">
        <div className="page-heading"><div><h1>协议解析工作台</h1><span>粘贴设备报文，快速查看字段、字节与诊断结果。</span></div><div className="heading-actions"><button type="button" onClick={() => fileInputRef.current?.click()}>导入文本</button><button type="button" onClick={() => setView("samples")}>打开样例库</button></div></div>
        <input ref={fileInputRef} className="visually-hidden" type="file" accept=".txt,.log,.hex,text/plain" onChange={importText}/>

        <div className={`workbench${!result ? " is-empty" : ""}`}>
          <section className="panel input-panel">
            <div className="panel-title"><div><span className="step">01</span><strong>输入原始帧</strong></div><span className="byte-count">{inputState.count} Bytes</span></div>
            <div className="input-body">
              <div className="auto-recognition"><ToolIcon name="format"/><div><strong>协议与端序自动识别</strong><p>同一输入框支持 Joymeter 小口径和沃特曼大口径报文，无需手动选择。</p></div></div>
              <div className={`hex-editor${!inputState.valid ? " has-error" : ""}`}>
                <div className="editor-toolbar"><span className="editor-label"><ToolIcon name="code"/>HEX / RAW FRAME</span><div className="tool-actions"><button className={actionFeedback === "paste" ? "is-success" : ""} type="button" onClick={pasteFrame}>{actionFeedback === "paste" ? <ToolIcon name="check"/> : <ToolIcon name="paste"/>}<span>{actionFeedback === "paste" ? "已粘贴" : "粘贴"}</span></button><button className={actionFeedback === "format" ? "is-success" : ""} type="button" onClick={formatInput}>{actionFeedback === "format" ? <ToolIcon name="check"/> : <ToolIcon name="format"/>}<span>{actionFeedback === "format" ? "已格式化" : "格式化"}</span></button><button className={actionFeedback === "clear" ? "is-success" : ""} type="button" onClick={clearFrame}>{actionFeedback === "clear" ? <ToolIcon name="check"/> : <ToolIcon name="clear"/>}<span>{actionFeedback === "clear" ? "已清空" : "清空"}</span></button></div></div>
                <div className="editor-main"><textarea ref={rawInputRef} value={rawInput} onChange={(event) => { setRawInput(event.target.value); setError(""); setResult(null); setSelectedField(null); setMessage("报文已修改，等待重新解析"); }} wrap="soft" spellCheck={false} aria-label="原始十六进制报文" placeholder="粘贴 HEX 报文，支持空格、换行、逗号和 0x 前缀"/></div>
                <div className="editor-status">{inputState.valid && inputState.count > 0 ? <span className="valid">● {inputState.text}</span> : <span aria-hidden="true"/>}<span>本地处理 · 不上传</span></div>
              </div>
              <div className="input-actions"><button className="parse-button" type="button" disabled={!inputState.valid || !inputState.count} onClick={parseFrame}>识别并解析报文</button><button className="sample-button" type="button" onClick={() => useSample(sampleList[(sampleList.findIndex((item) => item.value === rawInput) + 1) % sampleList.length])}>换个样例</button></div>
              {error || !inputState.valid ? <p className="inline-error" role="alert">{error || inputState.text}</p> : <p className="input-footnote">每次成功解析会保存到本机记录，最多保留 20 条，可随时清空。</p>}
            </div>
          </section>

          <section className="panel result-panel">
            <div className="panel-title"><div><span className="step">02</span><strong>解析结果</strong></div><span className="result-state"><i/> {message}</span></div>
            {result ? <>
              <div className="result-hero"><div className="protocol-identity"><span className="success-mark">✓</span><div><p>识别到协议</p><h2>{result.protocol}</h2><span>{result.manufacturer} · {result.categoryLabel}</span></div></div><div className="confidence"><span>匹配度</span><strong>{result.confidence}%</strong></div></div>
              <div className="primary-metrics"><div><span>核心读数</span><strong>{result.coreValue}</strong></div><div><span>表号</span><strong>{result.meterNo}</strong></div><div><span>数据标识 DI</span><strong>{result.dataIdentifier}</strong></div><div><span>控制码</span><strong>{result.controlCode}</strong></div></div>
              <div className="tabs" role="tablist" aria-label="解析结果视图">{tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
                event.preventDefault();
                const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                setActiveTab(tabs[nextIndex].id);
                (event.currentTarget.parentElement?.children[nextIndex] as HTMLButtonElement | undefined)?.focus();
              }}>{tab.label}{tab.id === "history" && result.history.length > 0 && <em>{result.history.length}</em>}{tab.id === "diagnostics" && <em>{result.diagnostics.length}</em>}</button>)}</div>
              <div className="tab-content">
                {activeTab === "overview" && <>
                  {analysis && result.protocolId !== "wotman-command" && <section className={`analysis-card analysis-${analysis.level}`} aria-label="分析结论">
                    <header><div><span className="analysis-icon">{analysis.level === "normal" ? "✓" : analysis.level === "abnormal" ? "×" : "!"}</span><strong>上报分析</strong></div><span className="analysis-status">{analysis.statusLabel}</span></header>
                    <div className="analysis-body">
                      <div className="analysis-summary-grid">{analysis.items.map((item) => <article className={`analysis-item analysis-item-${item.key}`} key={item.key}><span>{item.label}</span><strong>{item.value}</strong>{item.note && <small>{item.note}</small>}</article>)}</div>
                      <p className="analysis-advice"><strong>建议</strong>{analysis.recommendation}</p>
                    </div>
                  </section>}
                  <div className="result-insights"><article><span>帧长度</span><strong>{result.rawBytes.length} Bytes</strong></article><article><span>已识别字段</span><strong>{result.fields.length} 项</strong></article><article><span>诊断状态</span><strong>{result.diagnostics.some((item) => item.level === "bad") ? "存在错误" : result.diagnostics.some((item) => item.level === "warn") ? "需要关注" : "全部通过"}</strong></article><article><span>历史记录</span><strong>{result.history.length} 条</strong></article></div>
                  <div className="overview-sections">{result.overviewSections.map((section) => {
                    const visibleItems = section.items.filter((item) => item.value !== null && item.value !== "—");
                    return <section className={`overview-group overview-${section.id}`} data-count={visibleItems.length} key={section.id}><h3><span>{section.title}</span><em>{visibleItems.length} 项</em></h3><div className="metric-grid">{visibleItems.map((item) => <article key={item.key}><span>{item.label}</span><strong>{formatMetric(item.value, item.unit)}</strong>{item.note && <small>{item.note}</small>}</article>)}</div></section>;
                  })}</div>
                </>}
                {activeTab === "fields" && <FieldExplanation result={result} selectedField={selectedField} onSelect={setSelectedField}/>}
                {activeTab === "bytes" && <ByteMap result={result} selectedField={selectedField} onSelect={setSelectedField}/>} 
                {activeTab === "history" && (result.history.length ? <div className="table-scroll"><table><thead><tr><th>采集时间</th><th>正向累计</th><th>反向累计</th><th>瞬时流量</th><th>压力</th></tr></thead><tbody>{result.history.map((item, index) => <tr key={`${item.collectTime}-${index}`}><td>{item.collectTime}</td><td>{item.forwardFlow ?? "—"}</td><td>{item.reverseFlow ?? "—"}</td><td>{item.instantFlow ?? "—"}</td><td>{item.pressure ?? "—"}</td></tr>)}</tbody></table></div> : <div className="empty-tab"><span>↺</span><strong>这条报文没有历史数据</strong><p>可在样例库载入沃特曼 9021 报文体验历史数据解析。</p></div>)}
                {activeTab === "diagnostics" && <div className="diagnostic-list">{result.diagnostics.map((item, index) => <article className={`diag-${item.level}`} key={`${item.text}-${index}`}><span>{item.level === "ok" ? "✓" : item.level === "warn" ? "!" : "×"}</span><div><strong>{item.level === "ok" ? "检查通过" : item.level === "warn" ? "需要关注" : "解析错误"}</strong><p>{item.text}</p></div></article>)}</div>}
                {activeTab === "json" && <div className="json-view"><div className="json-toolbar"><span><ToolIcon name="code"/>结构化解析结果</span><div className="tool-actions"><button className={actionFeedback === "copy-json" ? "is-success" : ""} type="button" onClick={() => copyText(JSON.stringify(result, null, 2), "JSON", "copy-json")}>{actionFeedback === "copy-json" ? <ToolIcon name="check"/> : <ToolIcon name="copy"/>}<span>{actionFeedback === "copy-json" ? "已复制" : "复制 JSON"}</span></button><button className={actionFeedback === "export-json" ? "is-success" : ""} type="button" onClick={exportJson}>{actionFeedback === "export-json" ? <ToolIcon name="check"/> : <ToolIcon name="download"/>}<span>{actionFeedback === "export-json" ? "已导出" : "导出文件"}</span></button></div></div><pre>{JSON.stringify(result, null, 2)}</pre></div>}
              </div>
            </> : <div className="result-empty"><span>68</span><h2>等待数据帧</h2><p>粘贴或导入报文后，结果会在这里分层展示。</p><button type="button" onClick={() => setView("samples")}>从样例开始</button></div>}
          </section>
        </div>
      </section>}

      {view === "commands" && <section className="page command-page">
        <div className="page-heading"><div><p className="eyebrow">DEVICE DOWNLINK COMMAND</p><h1>设备写入指令</h1><span>按厂商协议独立生成写入帧；反向解析统一在协议解析工作台完成。</span></div><button className="primary-link" type="button" onClick={() => setView("studio")}>返回解析工作台</button></div>
        <div className="command-content-layout">
          <aside className="command-directory" aria-label="指令目录">
            <header className="command-directory-header">
              <div className="command-protocol-control">
                <span>当前协议</span>
                <button className="command-protocol-trigger" type="button" aria-expanded={protocolPickerOpen} aria-controls="protocol-picker" onClick={() => setProtocolPickerOpen((open) => !open)}>
                  <span className="protocol-avatar">{currentProtocol.manufacturer.slice(0, 2).toUpperCase()}</span>
                  <span className="protocol-copy"><strong>{currentProtocol.manufacturer}</strong><small>{currentProtocol.product}</small></span>
                  <i aria-hidden="true"/>
                </button>
                {protocolPickerOpen && <div className="command-protocol-picker" id="protocol-picker" aria-label="协议库选择器">
                  <label><span className="sr-only">搜索协议</span><input autoFocus value={protocolSearch} placeholder="搜索厂商、设备或协议…" onChange={(event) => setProtocolSearch(event.target.value)}/></label>
                  <div>{filteredProtocols.map((protocol) => <button className={protocol.id === commandVendor ? "active" : ""} type="button" key={protocol.id} onClick={() => selectCommandProtocol(protocol.id)}><span><strong>{protocol.manufacturer}</strong><small>{protocol.product}</small></span><em>{protocol.id === commandVendor ? "✓" : "选择"}</em></button>)}</div>
                  {!filteredProtocols.length && <p>没有找到匹配协议</p>}
                </div>}
              </div>
              <div className="command-directory-title"><strong>指令目录</strong><span>{commandCatalog[commandVendor].reduce((total, group) => total + group.items.length, 0)} 项</span></div>
              <label className="command-search"><span className="sr-only">搜索指令</span><input value={commandSearch} placeholder="搜索名称或 DI…" onChange={(event) => setCommandSearch(event.target.value)}/></label>
            </header>
            <nav className="command-flat-list">{visibleCommandGroups.flatMap((group) => group.items).map((item) => <button className={`command-item-button${currentCommandId === item.id ? " active" : ""}`} type="button" aria-current={currentCommandId === item.id ? "page" : undefined} key={item.id} onClick={() => selectCommand(item.id)}><span>{item.label}</span><code>{item.di}</code></button>)}</nav>
            {!visibleCommandGroups.length && <div className="command-directory-empty">没有匹配指令</div>}
          </aside>
          <div className="command-mobile-select">
            <label><span>设备协议</span><select value={commandVendor} onChange={(event) => selectCommandProtocol(event.target.value as CommandVendor)}>{commandProtocols.map((protocol) => <option value={protocol.id} key={protocol.id}>{protocol.manufacturer} · {protocol.product}</option>)}</select></label>
            <label><span>当前指令</span><select value={currentCommandId} onChange={(event) => selectCommand(event.target.value)}>{commandCatalog[commandVendor].flatMap((group) => group.items.map((item) => <option value={item.id} key={item.id}>{item.label} · {item.di}</option>))}</select></label>
          </div>
          <div className="command-workbench">
          <section className="panel command-form-panel">
            <div className="panel-title"><div><span className="step">01</span><strong>{activeCommandPresentation.formTitle}</strong></div><span className="byte-count">实时组帧</span></div>
            <div className="command-generation-mode" role="group" aria-label="指令生成数量">
              <button className={commandGenerationMode === "single" ? "active" : ""} type="button" onClick={() => setCommandGenerationMode("single")}><strong>单表生成</strong><span>查看完整字段</span></button>
              <button className={commandGenerationMode === "batch" ? "active" : ""} type="button" onClick={() => { setCommandGenerationMode("batch"); if (!batchMeterInput.trim()) setBatchMeterInput(activeMeterAddress); }}><strong>批量表号</strong><span>生成后导出 Excel</span></button>
            </div>
            {commandVendor === "joymeter" ? <div className="command-form">
              {renderMeterAddressField("仪表地址", joymeterInput.meterAddress, (meterAddress) => setJoymeterInput((current) => ({ ...current, meterAddress })), "输入展示顺序的表号，最多 14 位；发送时自动按 7 字节 BCD、低字节在前编码。")}
              {joymeterCommandType === "network" && <>
                <div className="command-form-row"><label><span>服务器 IP 地址</span><input value={joymeterInput.ip} inputMode="decimal" onChange={(event) => setJoymeterInput((current) => ({ ...current, ip: event.target.value }))}/><small>默认：60.205.218.69</small></label><label><span>服务器端口</span><input value={joymeterInput.port} inputMode="numeric" onChange={(event) => setJoymeterInput((current) => ({ ...current, port: event.target.value }))}/><small>范围 1–65535，按 2 字节小端编码。</small></label></div>
                <div className="command-fixed-fields"><span>固定协议参数</span><strong>控制码 24H</strong><strong>数据标识 A184H</strong><strong>协议 UDP · 01H</strong><strong>长度 0AH</strong></div>
              </>}
              {joymeterCommandType === "base" && <><label><span>基表读数（L）</span><input value={joymeterInput.baseReading} inputMode="numeric" maxLength={8} onChange={(event) => setJoymeterInput((current) => ({ ...current, baseReading: event.target.value }))}/><small>1–8 位整数；按 4 字节 BCD、小端编码，末尾固定追加 00H。</small></label><div className="command-fixed-fields"><span>固定协议参数</span><strong>控制码 24H</strong><strong>数据标识 A171H</strong><strong>长度 08H</strong></div></>}
              {joymeterCommandType === "valve" && <><fieldset className="command-choice"><legend>阀门操作</legend><label className={joymeterInput.valveAction === "open" ? "active" : ""}><input type="radio" name="joymeter-valve-action" checked={joymeterInput.valveAction === "open"} onChange={() => setJoymeterInput((current) => ({ ...current, valveAction: "open" }))}/><span>开阀</span><small>控制字 55H</small></label><label className={joymeterInput.valveAction === "close" ? "active" : ""}><input type="radio" name="joymeter-valve-action" checked={joymeterInput.valveAction === "close"} onChange={() => setJoymeterInput((current) => ({ ...current, valveAction: "close" }))}/><span>关阀</span><small>控制字 99H</small></label></fieldset><div className="command-fixed-fields"><span>固定协议参数</span><strong>控制码 24H</strong><strong>数据标识 A017H</strong><strong>长度 04H</strong></div></>}
              {(joymeterCommandType === "reporting" || joymeterCommandType === "start") && <label><span>上报起始时间（0–23 点）</span><input value={joymeterInput.startHour} inputMode="numeric" onChange={(event) => setJoymeterInput((current) => ({ ...current, startHour: event.target.value }))}/><small>按 1 字节 BCD 小时编码，例如 3 点为 03H。</small></label>}
              {(joymeterCommandType === "reporting" || joymeterCommandType === "random") && <label><span>最大随机间隔（秒）</span><input value={joymeterInput.maxRandomSeconds} inputMode="numeric" onChange={(event) => setJoymeterInput((current) => ({ ...current, maxRandomSeconds: event.target.value }))}/><small>范围 10–65535 秒，按 2 字节无符号整数、小端编码。</small></label>}
              {(joymeterCommandType === "reporting" || joymeterCommandType === "period") && <label><span>上报周期（小时）</span><input value={joymeterInput.reportPeriodHours} inputMode="numeric" onChange={(event) => setJoymeterInput((current) => ({ ...current, reportPeriodHours: event.target.value }))}/><small>范围 1–255 小时，按 1 字节无符号整数编码。</small></label>}
              {["reporting", "start", "random", "period"].includes(joymeterCommandType) && <div className="command-fixed-fields"><span>固定协议参数</span><strong>控制码 24H</strong><strong>数据标识 {joymeterMetadata[joymeterCommandType].di}</strong><strong>序列号 00H</strong></div>}
              {commandGenerationMode === "single" && joymeterCommandPreview.error && <p className="command-error" role="alert">{joymeterCommandPreview.error}</p>}
              <button className="sample-button command-reset" type="button" onClick={() => setJoymeterInput({ ...defaultJoymeterInput })}>恢复 Joymeter 示例参数</button>
            </div> : commandType === "network" ? <div className="command-form">
              {renderMeterAddressField("仪表地址", commandInput.meterAddress, (meterAddress) => setCommandInput((current) => ({ ...current, meterAddress })), "输入展示顺序的表号，最多 14 位；发送时自动按低字节在前编码。")}
              <div className="command-form-row">
                <label><span>主用 IP 地址</span><input value={commandInput.primaryIp} inputMode="decimal" onChange={(event) => setCommandInput((current) => ({ ...current, primaryIp: event.target.value }))}/><small>默认：60.205.218.69</small></label>
                <label><span>主用端口</span><input value={commandInput.primaryPort} inputMode="numeric" onChange={(event) => setCommandInput((current) => ({ ...current, primaryPort: event.target.value }))}/><small>范围 1–65535，自动转为 2 字节小端。</small></label>
              </div>
              <label><span>APN</span><input value={commandInput.apn} maxLength={16} onChange={(event) => setCommandInput((current) => ({ ...current, apn: event.target.value }))}/><small>最多 16 个 ASCII 字符，不足部分自动补 00H。</small></label>
              <div className="command-fixed-fields"><span>固定协议参数</span><strong>控制码 04H</strong><strong>数据标识 8110H</strong><strong>长度 3BH</strong></div>
              {commandGenerationMode === "single" && commandPreview.error && <p className="command-error" role="alert">{commandPreview.error}</p>}
              <button className="sample-button command-reset" type="button" onClick={() => setCommandInput({ ...defaultCommandInput })}>恢复示例参数</button>
            </div> : commandType === "sync" ? <div className="command-form">
              {renderMeterAddressField("设备编号", syncCommandInput.meterAddress, (meterAddress) => setSyncCommandInput((current) => ({ ...current, meterAddress })), "输入展示顺序的设备编号；发送时自动按 7 字节 BCD、低字节在前编码。")}
              <label><span>当前累计流量（m³）</span><input value={syncCommandInput.cumulativeFlow} inputMode="decimal" onChange={(event) => setSyncCommandInput((current) => ({ ...current, cumulativeFlow: event.target.value }))}/><small>最多 2 位小数；按 4 字节 BCD、小端编码，单位固定为 2CH。</small></label>
              <div className="command-fixed-fields"><span>固定协议参数</span><strong>控制码 04H</strong><strong>数据标识 A016H</strong><strong>长度 0008H</strong><strong>单位 2CH</strong></div>
              {commandGenerationMode === "single" && syncCommandPreview.error && <p className="command-error" role="alert">{syncCommandPreview.error}</p>}
              <button className="sample-button command-reset" type="button" onClick={() => setSyncCommandInput({ meterAddress: "00430500003931", cumulativeFlow: "10" })}>恢复示例参数</button>
            </div> : commandType === "valve" ? <div className="command-form">
              {renderMeterAddressField("设备编号", valveCommandInput.meterAddress, (meterAddress) => setValveCommandInput((current) => ({ ...current, meterAddress })), "7 字节 BCD 地址，发送时低字节在前。")}
              <fieldset className="command-choice"><legend>阀门操作</legend><label className={valveCommandInput.action === "open" ? "active" : ""}><input type="radio" name="valve-action" checked={valveCommandInput.action === "open"} onChange={() => setValveCommandInput((current) => ({ ...current, action: "open" }))}/><span>开阀</span><small>控制字 55H</small></label><label className={valveCommandInput.action === "close" ? "active" : ""}><input type="radio" name="valve-action" checked={valveCommandInput.action === "close"} onChange={() => setValveCommandInput((current) => ({ ...current, action: "close" }))}/><span>关阀</span><small>控制字 99H</small></label></fieldset>
              <div className="command-fixed-fields"><span>固定协议参数</span><strong>控制码 04H</strong><strong>数据标识 A017H</strong><strong>长度 0004H</strong></div>
              {commandGenerationMode === "single" && valveCommandPreview.error && <p className="command-error" role="alert">{valveCommandPreview.error}</p>}
            </div> : commandType === "schedule" ? <div className="command-form command-schedule-form">
              {renderMeterAddressField("设备编号", scheduleMeterAddress, setScheduleMeterAddress, "每小时可设置两个上传分钟值；留空表示该时刻停用并编码为 FFH。")}
              <div className="schedule-tools"><strong>24 小时上传分钟</strong><div><button type="button" onClick={() => setUploadSchedule(Array.from({ length: 24 }, () => ["0", "30"]))}>设为整点 / 半点</button><button type="button" onClick={() => setUploadSchedule(Array.from({ length: 24 }, () => ["", ""]))}>全部停用</button></div></div>
              <div className="schedule-grid"><header><span>小时</span><span>分钟值 1</span><span>分钟值 2</span></header>{uploadSchedule.map(([first, second], hour) => <div className="schedule-row" key={hour}><strong>{hour.toString().padStart(2, "0")} 时</strong><input aria-label={`${hour} 点第一个上传分钟`} inputMode="numeric" placeholder="停用" value={first} onChange={(event) => setUploadSchedule((current) => current.map((pair, index) => index === hour ? [event.target.value, pair[1]] : pair))}/><input aria-label={`${hour} 点第二个上传分钟`} inputMode="numeric" placeholder="停用" value={second} onChange={(event) => setUploadSchedule((current) => current.map((pair, index) => index === hour ? [pair[0], event.target.value] : pair))}/></div>)}</div>
              <div className="command-fixed-fields"><span>固定协议参数</span><strong>控制码 04H</strong><strong>数据标识 8104H</strong><strong>长度 0033H</strong></div>
              {commandGenerationMode === "single" && scheduleCommandPreview.error && <p className="command-error" role="alert">{scheduleCommandPreview.error}</p>}
            </div> : <div className="command-form">
              {renderMeterAddressField("设备编号", intervalCommandInput.meterAddress, (meterAddress) => setIntervalCommandInput((current) => ({ ...current, meterAddress })), "7 字节 BCD 地址，发送时低字节在前。")}
              <label><span>数据采集间隔（分钟）</span><input value={intervalCommandInput.intervalMinutes} inputMode="numeric" onChange={(event) => setIntervalCommandInput((current) => ({ ...current, intervalMinutes: event.target.value }))}/><small>范围 1–255，按 1 字节无符号整数写入。</small></label>
              <div className="command-fixed-fields"><span>固定协议参数</span><strong>控制码 04H</strong><strong>数据标识 8105H</strong><strong>长度 0004H</strong></div>
              {commandGenerationMode === "single" && intervalCommandPreview.error && <p className="command-error" role="alert">{intervalCommandPreview.error}</p>}
              <button className="sample-button command-reset" type="button" onClick={() => setIntervalCommandInput({ meterAddress: "00430500003931", intervalMinutes: "60" })}>恢复示例参数</button>
            </div>}
          </section>

          <section className="panel command-result-panel">
            <div className="panel-title"><div><span className="step">02</span><strong>{commandGenerationMode === "batch" ? "批量指令" : "生成指令"}</strong></div><span className={`command-state${commandGenerationMode === "batch" ? batchReady ? " valid" : " invalid" : activeCommandPreview.result ? " valid" : " invalid"}`}>{commandGenerationMode === "batch" ? batchReady ? `● ${batchCommandRows.length} 条可导出` : "● 请检查批量表号或参数" : activeCommandPreview.result ? "● 长度与校验通过" : "● 等待有效参数"}</span></div>
            {commandGenerationMode === "batch" ? <div className="batch-command-result">
              <div className="batch-command-summary"><article><span>指令类型</span><strong>{commandMetadata.label}</strong><small>{commandMetadata.di}</small></article><article><span>有效表号</span><strong>{batchMeterState.valid.length}</strong><small>最多 500 个</small></article><article><span>可导出</span><strong>{batchCommandRows.length - batchBuildErrors.length}</strong><small>{batchBuildErrors.length ? `${batchBuildErrors.length} 条组帧失败` : "全部校验通过"}</small></article><button className={actionFeedback === "export-command" ? "is-success" : ""} type="button" disabled={!batchReady} onClick={exportBatchCommands}><ToolIcon name={actionFeedback === "export-command" ? "check" : "download"}/><span>{actionFeedback === "export-command" ? "已导出 Excel" : "导出 Excel"}</span></button></div>
              {batchCommandRows.length > 0 ? <div className="batch-command-table-wrap"><table className="batch-command-table"><thead><tr><th>序号</th><th>表号</th><th>状态</th><th>完整 HEX 指令</th></tr></thead><tbody>{batchCommandRows.slice(0, 50).map((row, index) => <tr key={row.meterAddress}><td>{index + 1}</td><td><code>{row.meterAddress}</code></td><td className={row.result ? "valid" : "invalid"}>{row.result ? "可导出" : row.error}</td><td><code>{row.result?.compactHex ?? "—"}</code></td></tr>)}</tbody></table>{batchCommandRows.length > 50 && <p>当前预览前 50 条，Excel 将导出全部 {batchCommandRows.length} 条。</p>}</div> : <div className="command-empty"><strong>输入批量表号</strong><p>每行粘贴一个表号，右侧会立即生成并校验。</p></div>}
              {!batchReady && batchCommandRows.length > 0 && <p className="batch-export-hint">修正格式错误或指令参数后，才可导出 Excel，避免遗漏设备。</p>}
            </div> : activeCommandPreview.result ? <>
              <div className="command-summary"><div><span>{activeCommandPresentation.primaryLabel}</span><strong>{activeCommandPresentation.primaryValue}</strong></div><div><span>{activeCommandPresentation.secondaryLabel}</span><strong>{activeCommandPresentation.secondaryValue}</strong></div><div><span>校验码 CS</span><strong>{activeCommandPreview.result.checksum}</strong></div></div>
              <div className="command-output"><div className="command-output-head"><div><strong>完整 HEX 指令</strong><span>{activeCommandPresentation.outputHint}</span></div><button className={actionFeedback === "copy-command" ? "is-success" : ""} type="button" onClick={() => copyText(activeCommandPreview.result!.compactHex, activeCommandPresentation.copyLabel, "copy-command")}><ToolIcon name={actionFeedback === "copy-command" ? "check" : "copy"}/>{actionFeedback === "copy-command" ? "已复制" : "复制指令"}</button></div><textarea readOnly value={activeCommandPreview.result.compactHex} aria-label={activeCommandPresentation.copyLabel}/></div>
              <div className="command-explanation"><header><strong>字段组成</strong><span>{activeCommandPresentation.fieldHint}</span></header><FieldTable fields={activeCommandPreview.result.fields} selectedField={selectedField} onSelect={setSelectedField}/></div>
            </> : <div className="command-empty"><strong>参数尚未完成</strong><p>修正左侧提示后会自动生成完整指令。</p></div>}
          </section>
        </div>
        </div>
      </section>}

      {view === "library" && <section className="page collection-page"><div className="page-heading"><div><p className="eyebrow">PROTOCOL REGISTRY</p><h1>协议能力库</h1><span>查看当前已经接入并可由后台解析内核自动识别的协议。</span></div><button className="primary-link" type="button" onClick={() => setView("studio")}>返回工作台</button></div><div className="collection-grid">{parsers.map((parser, index) => <article className="collection-card" key={parser.id}><div className="card-top"><span className="protocol-icon">{String(index + 1).padStart(2, "0")}</span><span className="ready-badge">● 可用</span></div><p>{parser.category === "water" ? "水务计量" : parser.category}</p><h2>{parser.name}</h2><code>{parser.id}</code><div className="capability-list">{parserCapabilities[parser.id]?.map((item) => <span key={item}>{item}</span>)}</div><button type="button" onClick={() => setView("studio")}>进入自动解析</button></article>)}</div></section>}

      {view === "samples" && <section className="page collection-page"><div className="page-heading"><div><p className="eyebrow">FRAME PLAYGROUND</p><h1>样例帧</h1><span>无需准备设备数据，选择样例即可验证完整解析链路。</span></div><button className="primary-link" type="button" onClick={() => setView("studio")}>返回工作台</button></div><div className="sample-grid">{sampleList.map((sample) => <article className="sample-card" key={sample.id}><div><span className="sample-type">{sample.protocolId === "wotman-big" ? "WOTMAN" : sample.protocolId === "joymeter-command" ? "JOYMETER" : "CJ/T 188"}</span><strong>{parseHex(sample.value).length} Bytes</strong></div><h2>{sample.name}</h2><p>{sample.description}</p><code>{sample.value}</code><footer><button type="button" onClick={() => copyText(sample.value, "样例报文")}>复制 HEX</button><button className="primary-link" type="button" onClick={() => useSample(sample)}>载入并解析</button></footer></article>)}</div></section>}

      {view === "records" && <section className="page collection-page"><div className="page-heading"><div><p className="eyebrow">LOCAL HISTORY</p><h1>本机解析记录</h1><span>最近 20 条成功解析，仅保存在当前浏览器。</span></div><div className="heading-actions"><button type="button" disabled={!records.length} onClick={clearRecords}>清空记录</button><button className="primary-link" type="button" onClick={() => setView("studio")}>返回工作台</button></div></div>{records.length ? <div className="record-list">{records.map((record) => <article key={record.id}><div className="record-main"><span>{new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}</span><h2>{record.protocol}</h2><p>表号 {record.meterNo} · {record.coreValue}</p></div><code>{record.raw}</code><div><button type="button" onClick={() => copyText(record.raw, "历史报文")}>复制</button><button className="primary-link" type="button" onClick={() => reuseRecord(record)}>重新解析</button></div></article>)}</div> : <div className="large-empty"><span>↺</span><h2>还没有解析记录</h2><p>完成一次报文解析后，它会自动出现在这里。</p><button className="primary-link" type="button" onClick={() => setView("samples")}>使用样例开始</button></div>}</section>}
    </div>

    {/* 手机端使用固定底部导航，避免侧栏隐藏后协议库、样例和记录失去入口。 */}
    <nav className="mobile-navigation" aria-label="手机端主导航">
      <button className={view === "studio" ? "active" : ""} type="button" aria-current={view === "studio" ? "page" : undefined} onClick={() => setView("studio")}><NavIcon name="parser"/><span>协议解析</span></button>
      <button className={view === "commands" ? "active" : ""} type="button" aria-current={view === "commands" ? "page" : undefined} onClick={() => setView("commands")}><NavIcon name="command"/><span>指令生成</span></button>
      <button className={view === "library" ? "active" : ""} type="button" aria-current={view === "library" ? "page" : undefined} onClick={() => setView("library")}><NavIcon name="library"/><span>协议库</span></button>
      <button className={view === "samples" ? "active" : ""} type="button" aria-current={view === "samples" ? "page" : undefined} onClick={() => setView("samples")}><NavIcon name="sample"/><span>样例帧</span></button>
      <button className={view === "records" ? "active" : ""} type="button" aria-current={view === "records" ? "page" : undefined} onClick={() => setView("records")}><NavIcon name="history"/><span>解析记录</span></button>
    </nav>
    {toast && <div className="toast" role="status">✓ {toast}</div>}
  </main>;
}
