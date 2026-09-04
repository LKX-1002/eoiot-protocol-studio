"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { hex, parseHex } from "@/lib/protocols/bytes";
import { buildAnalysisSummary } from "@/lib/protocols/analysis";
import { parseWithRegistry, parsers, validateWithRegistry } from "@/lib/protocols/registry";
import { sampleList, samples } from "@/lib/protocols/samples";
import type { ParseResult, ParsedField } from "@/lib/protocols/types";

type TabId = "overview" | "fields" | "bytes" | "history" | "diagnostics" | "json";
type AppView = "studio" | "library" | "samples" | "records";
type ActionFeedback = "paste" | "format" | "clear" | "copy-json" | "export-json" | null;

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
 * 顶栏品牌标志使用内联 SVG，以便跟随应用的手动深浅色主题切换。
 * 浅色单卡片代表统一的协议核心，圆点和双线代表结构化协议字段。
 * 该结构与确认稿保持一致，并能在导航栏和浏览器小图标中清晰识别。
 */
function BrandMark() {
  return <svg className="brand-mark" aria-hidden="true" viewBox="0 0 40 40">
    <rect className="brand-logo-card" x="1" y="1" width="38" height="38" rx="10"/>
    <circle className="brand-logo-detail" cx="12.5" cy="20" r="3.1"/>
    <path className="brand-logo-line" d="M19 14.8h13M19 25.2h9.5"/>
  </svg>;
}

/** 侧栏导航统一使用 18px 线性 SVG，保证图标线宽、基线和文字间距一致。 */
function NavIcon({ name }: { name: "parser" | "library" | "sample" | "history" | "device" | "team" }) {
  const paths = {
    parser: <><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5M8 12h8M8 16h5"/></>,
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
  const [result, setResult] = useState<ParseResult | null>(initialResult);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [selectedField, setSelectedField] = useState<ParsedField | null>(null);
  const [records, setRecords] = useState<ParseRecord[]>([]);
  const [message, setMessage] = useState("已载入示例，可直接体验解析结果");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        <button className={`nav-item${view === "library" ? " active" : ""}`} type="button" onClick={() => setView("library")}><NavIcon name="library"/><b>协议库</b></button>
        <button className={`nav-item${view === "samples" ? " active" : ""}`} type="button" onClick={() => setView("samples")}><NavIcon name="sample"/><b>样例帧</b></button>
        <button className={`nav-item${view === "records" ? " active" : ""}`} type="button" onClick={() => setView("records")}><NavIcon name="history"/><b>解析记录</b></button>
        <p className="nav-title">云端能力</p>
        <button className="nav-item is-disabled" type="button" disabled><NavIcon name="device"/><b>设备与上报</b><em>规划中</em></button>
        <button className="nav-item is-disabled" type="button" disabled><NavIcon name="team"/><b>团队协作</b><em>规划中</em></button>
      </nav><div className="local-note"><span className="secure-dot"/><strong>隐私安全</strong><p>解析与记录仅保存在本机</p></div></aside>

      {view === "studio" && <section className="page studio-page">
        <div className="page-heading"><div><h1>协议解析工作台</h1><span>从原始 HEX 到字段、字节和诊断结果，一屏完成协议调试。</span></div><div className="heading-actions"><button type="button" onClick={() => fileInputRef.current?.click()}>导入文本</button><button type="button" onClick={() => setView("samples")}>打开样例库</button></div></div>
        <input ref={fileInputRef} className="visually-hidden" type="file" accept=".txt,.log,.hex,text/plain" onChange={importText}/>

        <div className="workbench">
          <section className="panel input-panel">
            <div className="panel-title"><div><span className="step">01</span><strong>输入原始帧</strong></div><span className="byte-count">{inputState.count} Bytes</span></div>
            <div className="input-body">
              <div className="auto-recognition"><span className="secure-dot"/><div><strong>协议与端序自动识别</strong><p>同一输入框支持 Joymeter 小口径和沃特曼大口径报文，无需手动选择。</p></div></div>
              <div className={`hex-editor${!inputState.valid ? " has-error" : ""}`}>
                <div className="editor-toolbar"><span className="editor-label"><ToolIcon name="code"/>HEX / RAW FRAME</span><div className="tool-actions"><button className={actionFeedback === "paste" ? "is-success" : ""} type="button" onClick={pasteFrame}>{actionFeedback === "paste" ? <ToolIcon name="check"/> : <ToolIcon name="paste"/>}<span>{actionFeedback === "paste" ? "已粘贴" : "粘贴"}</span></button><button className={actionFeedback === "format" ? "is-success" : ""} type="button" onClick={formatInput}>{actionFeedback === "format" ? <ToolIcon name="check"/> : <ToolIcon name="format"/>}<span>{actionFeedback === "format" ? "已格式化" : "格式化"}</span></button><button className={actionFeedback === "clear" ? "is-success" : ""} type="button" onClick={clearFrame}>{actionFeedback === "clear" ? <ToolIcon name="check"/> : <ToolIcon name="clear"/>}<span>{actionFeedback === "clear" ? "已清空" : "清空"}</span></button></div></div>
                <div className="editor-main"><textarea value={rawInput} onChange={(event) => { setRawInput(event.target.value); setError(""); setResult(null); setSelectedField(null); setMessage("报文已修改，等待重新解析"); }} spellCheck={false} aria-label="原始十六进制报文" placeholder="粘贴 HEX 报文，支持空格、换行、逗号和 0x 前缀"/></div>
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
                  {analysis && <section className={`analysis-card analysis-${analysis.level}`} aria-label="分析结论">
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

      {view === "library" && <section className="page collection-page"><div className="page-heading"><div><p className="eyebrow">PROTOCOL REGISTRY</p><h1>协议能力库</h1><span>查看当前已经接入并可由后台解析内核自动识别的协议。</span></div><button className="primary-link" type="button" onClick={() => setView("studio")}>返回工作台</button></div><div className="collection-grid">{parsers.map((parser, index) => <article className="collection-card" key={parser.id}><div className="card-top"><span className="protocol-icon">{String(index + 1).padStart(2, "0")}</span><span className="ready-badge">● 可用</span></div><p>{parser.category === "water" ? "水务计量" : parser.category}</p><h2>{parser.name}</h2><code>{parser.id}</code><div className="capability-list">{parserCapabilities[parser.id]?.map((item) => <span key={item}>{item}</span>)}</div><button type="button" onClick={() => setView("studio")}>进入自动解析</button></article>)}</div></section>}

      {view === "samples" && <section className="page collection-page"><div className="page-heading"><div><p className="eyebrow">FRAME PLAYGROUND</p><h1>样例帧</h1><span>无需准备设备数据，选择样例即可验证完整解析链路。</span></div><button className="primary-link" type="button" onClick={() => setView("studio")}>返回工作台</button></div><div className="sample-grid">{sampleList.map((sample) => <article className="sample-card" key={sample.id}><div><span className="sample-type">{sample.protocolId === "wotman-big" ? "WOTMAN" : "CJ/T 188"}</span><strong>{parseHex(sample.value).length} Bytes</strong></div><h2>{sample.name}</h2><p>{sample.description}</p><code>{sample.value}</code><footer><button type="button" onClick={() => copyText(sample.value, "样例报文")}>复制 HEX</button><button className="primary-link" type="button" onClick={() => useSample(sample)}>载入并解析</button></footer></article>)}</div></section>}

      {view === "records" && <section className="page collection-page"><div className="page-heading"><div><p className="eyebrow">LOCAL HISTORY</p><h1>本机解析记录</h1><span>最近 20 条成功解析，仅保存在当前浏览器。</span></div><div className="heading-actions"><button type="button" disabled={!records.length} onClick={clearRecords}>清空记录</button><button className="primary-link" type="button" onClick={() => setView("studio")}>返回工作台</button></div></div>{records.length ? <div className="record-list">{records.map((record) => <article key={record.id}><div className="record-main"><span>{new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}</span><h2>{record.protocol}</h2><p>表号 {record.meterNo} · {record.coreValue}</p></div><code>{record.raw}</code><div><button type="button" onClick={() => copyText(record.raw, "历史报文")}>复制</button><button className="primary-link" type="button" onClick={() => reuseRecord(record)}>重新解析</button></div></article>)}</div> : <div className="large-empty"><span>↺</span><h2>还没有解析记录</h2><p>完成一次报文解析后，它会自动出现在这里。</p><button className="primary-link" type="button" onClick={() => setView("samples")}>使用样例开始</button></div>}</section>}
    </div>

    {/* 手机端使用固定底部导航，避免侧栏隐藏后协议库、样例和记录失去入口。 */}
    <nav className="mobile-navigation" aria-label="手机端主导航">
      <button className={view === "studio" ? "active" : ""} type="button" aria-current={view === "studio" ? "page" : undefined} onClick={() => setView("studio")}><NavIcon name="parser"/><span>协议解析</span></button>
      <button className={view === "library" ? "active" : ""} type="button" aria-current={view === "library" ? "page" : undefined} onClick={() => setView("library")}><NavIcon name="library"/><span>协议库</span></button>
      <button className={view === "samples" ? "active" : ""} type="button" aria-current={view === "samples" ? "page" : undefined} onClick={() => setView("samples")}><NavIcon name="sample"/><span>样例帧</span></button>
      <button className={view === "records" ? "active" : ""} type="button" aria-current={view === "records" ? "page" : undefined} onClick={() => setView("records")}><NavIcon name="history"/><span>解析记录</span></button>
    </nav>
    {toast && <div className="toast" role="status">✓ {toast}</div>}
  </main>;
}
