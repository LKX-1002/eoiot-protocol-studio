"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { hex, parseHex } from "@/lib/protocols/bytes";
import { parseWithRegistry, parsers, validateWithRegistry } from "@/lib/protocols/registry";
import { sampleList, samples } from "@/lib/protocols/samples";
import type { ParseResult, ParsedField } from "@/lib/protocols/types";

type TabId = "overview" | "fields" | "bytes" | "history" | "diagnostics" | "json";
type AppView = "studio" | "library" | "samples" | "records";

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

const metricLabels: Record<string, { label: string; unit?: string }> = {
  totalFlow: { label: "累计流量", unit: "m³" }, forwardFlow: { label: "正向累计", unit: "m³" },
  reverseFlow: { label: "反向累计", unit: "m³" }, instantFlow: { label: "瞬时流量", unit: "m³/h" },
  pressure: { label: "压力", unit: "MPa" }, temperature: { label: "温度", unit: "℃" },
  meterVoltage: { label: "仪表电压", unit: "V" }, collectorVoltage: { label: "采集器电压", unit: "V" },
  csq: { label: "信号 CSQ" }, valveStatus: { label: "阀门状态" }, statusInfo: { label: "设备状态" },
  collectTime: { label: "采集时间" }, imei: { label: "IMEI" }, imsi: { label: "IMSI" },
  hardwareVersion: { label: "硬件版本" }, softwareVersion: { label: "软件版本" }, meterType: { label: "仪表类型" },
};

const parserCapabilities: Record<string, string[]> = {
  "cjt188-small": ["10H 冷水", "11H 生活热水", "12H 直饮水", "13H 中水", "14H–19H 保留", "CS 校验"],
  "wotman-big": ["9021 / 9023 / 9025", "历史数据", "压力温度", "设备身份", "业务告警"],
};

function formatMetric(value: string | number | null, unit?: string) {
  if (value === null || value === "—") return "—";
  const formatted = typeof value === "number" ? value.toLocaleString("zh-CN", { maximumFractionDigits: 3 }) : value;
  return unit ? `${formatted} ${unit}` : formatted;
}

function initialResult(): ParseResult | null {
  try { return parseWithRegistry(parseHex(samples.cjt188.value)); } catch { return null; }
}

/** 字节地图与字段表共享选中状态，便于从业务字段反查原始报文。 */
function ByteMap({ result, selectedField, onSelect }: { result: ParseResult; selectedField: ParsedField | null; onSelect: (field: ParsedField | null) => void }) {
  const ownerAt = (index: number) => result.fields.find((item) => index >= item.offset && index < item.offset + item.length);
  return <div className="byte-map-wrap">
    <div className="byte-map" aria-label="HEX 字节地图">{result.rawBytes.map((value, index) => {
      const owner = ownerAt(index);
      const selected = selectedField && index >= selectedField.offset && index < selectedField.offset + selectedField.length;
      return <button className={`byte-chip tone-${owner?.tone ?? "plain"}${selected ? " is-selected" : ""}`} key={`${index}-${value}`} type="button" onMouseEnter={() => onSelect(owner ?? null)} onFocus={() => onSelect(owner ?? null)}>
        <small>{index.toString(16).padStart(2, "0").toUpperCase()}</small>{hex([value])}
      </button>;
    })}</div>
    <div className="byte-selection">{selectedField ? <><strong>{selectedField.name}</strong><span>偏移 {selectedField.offset} · {selectedField.length} Bytes · {selectedField.value}{selectedField.unit ? ` ${selectedField.unit}` : ""}</span></> : <span>悬停或聚焦字节，查看所属字段和偏移。</span>}</div>
  </div>;
}

export function ProtocolStudio() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [view, setView] = useState<AppView>("studio");
  const [rawInput, setRawInput] = useState(samples.cjt188.value);
  const [parserId, setParserId] = useState("auto");
  const [intEndian, setIntEndian] = useState<"auto" | "be" | "le">("auto");
  const [result, setResult] = useState<ParseResult | null>(initialResult);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [selectedField, setSelectedField] = useState<ParsedField | null>(null);
  const [records, setRecords] = useState<ParseRecord[]>([]);
  const [message, setMessage] = useState("已载入示例，可直接体验解析结果");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
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

  const inputState = useMemo(() => {
    try {
      const bytes = parseHex(rawInput);
      if (!bytes.length) return { valid: true, count: 0, text: "等待输入" };
      validateWithRegistry(bytes, parserId, { intEndian });
      return { valid: true, count: bytes.length, text: "格式与帧校验通过" };
    } catch (caught) {
      let count = 0;
      try { count = parseHex(rawInput).length; } catch { /* 非法 HEX 无法可靠计算字节数。 */ }
      return { valid: false, count, text: caught instanceof Error ? caught.message : "HEX 或帧结构错误" };
    }
  }, [rawInput, parserId, intEndian]);

  const visibleMetrics = result
    ? Object.entries(result.metrics).filter(([key, value]) => metricLabels[key] && value !== null && value !== "—").slice(0, 9)
    : [];

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
      const parsed = parseWithRegistry(bytes, parserId, { intEndian });
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
    setParserId("auto");
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
    try { setRawInput(hex(parseHex(rawInput))); setError(""); setToast("报文格式已整理"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "无法格式化当前内容。"); }
  };

  const copyText = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setToast(`${label}已复制`); }
    catch { setError("浏览器未授予剪贴板权限，请手动复制。"); }
  };

  const pasteFrame = async () => {
    try { setRawInput(await navigator.clipboard.readText()); setError(""); setToast("已从剪贴板粘贴"); }
    catch { setError("浏览器未授予剪贴板读取权限，请使用 Ctrl+V。"); }
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
    URL.revokeObjectURL(url); setToast("JSON 已导出");
  };

  const reuseRecord = (record: ParseRecord) => { setRawInput(record.raw); setView("studio"); setMessage("已恢复历史报文，按 Ctrl + Enter 重新解析"); };
  const clearRecords = () => { setRecords([]); window.localStorage.removeItem("eoiot-records"); setToast("本机记录已清空"); };

  return <main className="studio-app" data-theme={theme} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); parseFrame(); } }}>
    <header className="topbar">
      <button className="brand brand-button" type="button" onClick={() => setView("studio")}><span className="brand-mark">EOI</span><span><strong>EOIOT</strong><small>Protocol Studio</small></span></button>
      <div className="workspace-switch"><strong>源一物联</strong><span>/ 协议研发空间</span></div>
      <span className="version-pill">V2 Preview</span>
      <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}><span>{theme === "light" ? "◐" : "☀"}</span>{theme === "light" ? "切换深色" : "切换浅色"}</button>
    </header>

    <div className="app-grid">
      <aside className="sidebar"><nav aria-label="主导航">
        <p className="nav-title">工作台</p>
        <button className={`nav-item${view === "studio" ? " active" : ""}`} type="button" onClick={() => setView("studio")}><span>⌁</span><b>协议解析</b></button>
        <button className={`nav-item${view === "library" ? " active" : ""}`} type="button" onClick={() => setView("library")}><span>◇</span><b>协议库</b></button>
        <button className={`nav-item${view === "samples" ? " active" : ""}`} type="button" onClick={() => setView("samples")}><span>▣</span><b>样例帧</b></button>
        <button className={`nav-item${view === "records" ? " active" : ""}`} type="button" onClick={() => setView("records")}><span>↺</span><b>解析记录</b></button>
        <p className="nav-title">云端能力</p>
        <button className="nav-item is-disabled" type="button" disabled><span>⌾</span><b>设备与上报</b><em>规划中</em></button>
        <button className="nav-item is-disabled" type="button" disabled><span>◎</span><b>团队协作</b><em>规划中</em></button>
      </nav><div className="local-note"><span className="secure-dot"/><strong>隐私安全</strong><p>解析与记录仅保存在本机</p></div></aside>

      {view === "studio" && <section className="page studio-page">
        <div className="page-heading"><div><h1>协议解析工作台</h1><span>从原始 HEX 到字段、字节和诊断结果，一屏完成协议调试。</span></div><div className="heading-actions"><button type="button" onClick={() => fileInputRef.current?.click()}>导入文本</button><button type="button" onClick={() => setView("samples")}>打开样例库</button></div></div>
        <input ref={fileInputRef} className="visually-hidden" type="file" accept=".txt,.log,.hex,text/plain" onChange={importText}/>

        <div className="workbench">
          <section className="panel input-panel">
            <div className="panel-title"><div><span className="step">01</span><strong>输入原始帧</strong></div><span className="byte-count">{inputState.count} Bytes</span></div>
            <div className="input-body">
              <div className="form-grid"><label><span>解析协议</span><select value={parserId} onChange={(event) => setParserId(event.target.value)}><option value="auto">智能识别（推荐）</option>{parsers.map((parser) => <option value={parser.id} key={parser.id}>{parser.name}</option>)}</select></label><label><span>整数端序</span><select value={intEndian} onChange={(event) => setIntEndian(event.target.value as "auto" | "be" | "le")}><option value="auto">自动</option><option value="be">大端 BE</option><option value="le">小端 LE</option></select></label></div>
              <div className={`hex-editor${!inputState.valid ? " has-error" : ""}`}>
                <div className="editor-toolbar"><span>HEX / RAW FRAME</span><div><button type="button" onClick={pasteFrame}>粘贴</button><button type="button" onClick={formatInput}>格式化</button><button type="button" onClick={() => { setRawInput(""); setResult(null); setError(""); }}>清空</button></div></div>
                <div className="editor-main"><textarea value={rawInput} onChange={(event) => { setRawInput(event.target.value); setError(""); setResult(null); setSelectedField(null); setMessage("报文已修改，等待重新解析"); }} spellCheck={false} aria-label="原始十六进制报文" placeholder="粘贴 HEX 报文，支持空格、换行、逗号和 0x 前缀"/></div>
                <div className="editor-status">{inputState.valid && inputState.count > 0 ? <span className="valid">● {inputState.text}</span> : <span aria-hidden="true"/>}<span>本地处理 · 不上传</span></div>
              </div>
              <div className="input-actions"><button className="parse-button" type="button" disabled={!inputState.valid || !inputState.count} onClick={parseFrame}>识别并解析报文 <kbd>Ctrl ↵</kbd></button><button className="sample-button" type="button" onClick={() => useSample(sampleList[(sampleList.findIndex((item) => item.value === rawInput) + 1) % sampleList.length])}>换个样例</button></div>
              {error || !inputState.valid ? <p className="inline-error" role="alert">{error || inputState.text}</p> : <p className="input-footnote">每次成功解析会保存到本机记录，最多保留 20 条，可随时清空。</p>}
            </div>
          </section>

          <section className="panel result-panel">
            <div className="panel-title"><div><span className="step">02</span><strong>解析结果</strong></div><span className="result-state"><i/> {message}</span></div>
            {result ? <>
              <div className="result-hero"><div className="protocol-identity"><span className="success-mark">✓</span><div><p>识别到协议</p><h2>{result.protocol}</h2><span>{result.manufacturer} · {result.categoryLabel}</span></div></div><div className="confidence"><span>匹配度</span><strong>{result.confidence}%</strong></div></div>
              <div className="primary-metrics"><div><span>核心读数</span><strong>{result.coreValue}</strong></div><div><span>表号</span><strong>{result.meterNo}</strong></div><div><span>数据标识 DI</span><strong>{result.dataIdentifier}</strong></div><div><span>控制码</span><strong>{result.controlCode}</strong></div></div>
              <div className="tabs" role="tablist">{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}{tab.id === "history" && result.history.length > 0 && <em>{result.history.length}</em>}{tab.id === "diagnostics" && <em>{result.diagnostics.length}</em>}</button>)}</div>
              <div className="tab-content">
                {activeTab === "overview" && <><div className="result-insights"><article><span>帧长度</span><strong>{result.rawBytes.length} Bytes</strong></article><article><span>已识别字段</span><strong>{result.fields.length} 项</strong></article><article><span>诊断状态</span><strong>{result.diagnostics.some((item) => item.level === "bad") ? "存在错误" : result.diagnostics.some((item) => item.level === "warn") ? "需要关注" : "全部通过"}</strong></article><article><span>历史记录</span><strong>{result.history.length} 条</strong></article></div><div className="metric-grid">{visibleMetrics.map(([key, value]) => <article key={key}><span>{metricLabels[key].label}</span><strong>{formatMetric(value, metricLabels[key].unit)}</strong></article>)}</div></>}
                {activeTab === "fields" && <div className="table-scroll"><table><thead><tr><th>偏移</th><th>字段</th><th>原始字节</th><th>解析值</th><th>说明</th></tr></thead><tbody>{result.fields.map((item) => <tr className={selectedField === item ? "is-selected" : ""} key={`${item.offset}-${item.name}`} onMouseEnter={() => setSelectedField(item)} onClick={() => setSelectedField(item)}><td>{item.offset}–{item.offset + Math.max(item.length - 1, 0)}</td><td>{item.name}</td><td><code>{item.raw || "—"}</code></td><td><strong>{item.value}</strong>{item.unit ? ` ${item.unit}` : ""}</td><td>{item.note ?? "—"}</td></tr>)}</tbody></table></div>}
                {activeTab === "bytes" && <ByteMap result={result} selectedField={selectedField} onSelect={setSelectedField}/>} 
                {activeTab === "history" && (result.history.length ? <div className="table-scroll"><table><thead><tr><th>采集时间</th><th>正向累计</th><th>反向累计</th><th>瞬时流量</th><th>压力</th></tr></thead><tbody>{result.history.map((item, index) => <tr key={`${item.collectTime}-${index}`}><td>{item.collectTime}</td><td>{item.forwardFlow ?? "—"}</td><td>{item.reverseFlow ?? "—"}</td><td>{item.instantFlow ?? "—"}</td><td>{item.pressure ?? "—"}</td></tr>)}</tbody></table></div> : <div className="empty-tab"><span>↺</span><strong>这条报文没有历史数据</strong><p>可在样例库载入沃特曼 9021 报文体验历史数据解析。</p></div>)}
                {activeTab === "diagnostics" && <div className="diagnostic-list">{result.diagnostics.map((item, index) => <article className={`diag-${item.level}`} key={`${item.text}-${index}`}><span>{item.level === "ok" ? "✓" : item.level === "warn" ? "!" : "×"}</span><div><strong>{item.level === "ok" ? "检查通过" : item.level === "warn" ? "需要关注" : "解析错误"}</strong><p>{item.text}</p></div></article>)}</div>}
                {activeTab === "json" && <div className="json-view"><div><button type="button" onClick={() => copyText(JSON.stringify(result, null, 2), "JSON")}>复制 JSON</button><button type="button" onClick={exportJson}>导出文件</button></div><pre>{JSON.stringify(result, null, 2)}</pre></div>}
              </div>
            </> : <div className="result-empty"><span>68</span><h2>等待数据帧</h2><p>粘贴或导入报文后，结果会在这里分层展示。</p><button type="button" onClick={() => setView("samples")}>从样例开始</button></div>}
          </section>
        </div>
      </section>}

      {view === "library" && <section className="page collection-page"><div className="page-heading"><div><p className="eyebrow">PROTOCOL REGISTRY</p><h1>协议能力库</h1><span>查看当前已经接入并可直接解析的协议插件。</span></div><button className="primary-link" type="button" onClick={() => setView("studio")}>返回工作台</button></div><div className="collection-grid">{parsers.map((parser, index) => <article className="collection-card" key={parser.id}><div className="card-top"><span className="protocol-icon">{String(index + 1).padStart(2, "0")}</span><span className="ready-badge">● 可用</span></div><p>{parser.category === "water" ? "水务计量" : parser.category}</p><h2>{parser.name}</h2><code>{parser.id}</code><div className="capability-list">{parserCapabilities[parser.id]?.map((item) => <span key={item}>{item}</span>)}</div><button type="button" onClick={() => { setParserId(parser.id); setView("studio"); }}>使用此协议解析</button></article>)}</div></section>}

      {view === "samples" && <section className="page collection-page"><div className="page-heading"><div><p className="eyebrow">FRAME PLAYGROUND</p><h1>样例帧</h1><span>无需准备设备数据，选择样例即可验证完整解析链路。</span></div><button className="primary-link" type="button" onClick={() => setView("studio")}>返回工作台</button></div><div className="sample-grid">{sampleList.map((sample) => <article className="sample-card" key={sample.id}><div><span className="sample-type">{sample.protocolId === "wotman-big" ? "WOTMAN" : "CJ/T 188"}</span><strong>{parseHex(sample.value).length} Bytes</strong></div><h2>{sample.name}</h2><p>{sample.description}</p><code>{sample.value}</code><footer><button type="button" onClick={() => copyText(sample.value, "样例报文")}>复制 HEX</button><button className="primary-link" type="button" onClick={() => useSample(sample)}>载入并解析</button></footer></article>)}</div></section>}

      {view === "records" && <section className="page collection-page"><div className="page-heading"><div><p className="eyebrow">LOCAL HISTORY</p><h1>本机解析记录</h1><span>最近 20 条成功解析，仅保存在当前浏览器。</span></div><div className="heading-actions"><button type="button" disabled={!records.length} onClick={clearRecords}>清空记录</button><button className="primary-link" type="button" onClick={() => setView("studio")}>返回工作台</button></div></div>{records.length ? <div className="record-list">{records.map((record) => <article key={record.id}><div className="record-main"><span>{new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}</span><h2>{record.protocol}</h2><p>表号 {record.meterNo} · {record.coreValue}</p></div><code>{record.raw}</code><div><button type="button" onClick={() => copyText(record.raw, "历史报文")}>复制</button><button className="primary-link" type="button" onClick={() => reuseRecord(record)}>重新解析</button></div></article>)}</div> : <div className="large-empty"><span>↺</span><h2>还没有解析记录</h2><p>完成一次报文解析后，它会自动出现在这里。</p><button className="primary-link" type="button" onClick={() => setView("samples")}>使用样例开始</button></div>}</section>}
    </div>
    {toast && <div className="toast" role="status">✓ {toast}</div>}
  </main>;
}
