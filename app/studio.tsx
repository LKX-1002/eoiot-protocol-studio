"use client";

import { useEffect, useMemo, useState } from "react";
import { hex, parseHex } from "@/lib/protocols/bytes";
import { parseWithRegistry, parsers } from "@/lib/protocols/registry";
import { samples } from "@/lib/protocols/samples";
import type { ParseResult, ParsedField } from "@/lib/protocols/types";

type TabId = "overview" | "fields" | "bytes" | "history" | "diagnostics" | "json";

/** 结果面板支持的标签页；使用稳定 id 保存当前选择。 */
const tabs: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "解析概览" },
  { id: "fields", label: "字段解释" },
  { id: "bytes", label: "字节地图" },
  { id: "history", label: "历史数据" },
  { id: "diagnostics", label: "诊断" },
  { id: "json", label: "JSON" },
];

/** 把解析器的标准指标键映射为用户可读名称和单位。 */
const metricLabels: Record<string, { label: string; unit?: string }> = {
  totalFlow: { label: "累计流量", unit: "m³" },
  forwardFlow: { label: "正向累计", unit: "m³" },
  reverseFlow: { label: "反向累计", unit: "m³" },
  instantFlow: { label: "瞬时流量", unit: "m³/h" },
  pressure: { label: "压力", unit: "MPa" },
  temperature: { label: "温度", unit: "℃" },
  meterVoltage: { label: "仪表电压", unit: "V" },
  collectorVoltage: { label: "采集器电压", unit: "V" },
  csq: { label: "信号 CSQ" },
  valveStatus: { label: "阀门状态" },
  statusInfo: { label: "设备状态" },
  collectTime: { label: "采集时间" },
  imei: { label: "IMEI" },
  imsi: { label: "IMSI" },
  hardwareVersion: { label: "硬件版本" },
  softwareVersion: { label: "软件版本" },
};

/** 统一格式化字符串、数字和空值，避免不同解析器各自处理展示。 */
function formatMetric(value: string | number | null, unit?: string) {
  if (value === null || value === "—") return "—";
  const formatted = typeof value === "number"
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: 3 })
    : value;
  return unit ? `${formatted} ${unit}` : formatted;
}

/** 首屏直接解析内置样例，让用户打开页面即可看到完整结果状态。 */
function initialResult(): ParseResult | null {
  try {
    return parseWithRegistry(parseHex(samples.cjt188.value));
  } catch {
    return null;
  }
}

/**
 * 字节地图组件。
 * 每个字节根据所属 ParsedField 着色，并与字段表共享选中状态。
 */
function ByteMap({ result, selectedField, onSelect }: {
  result: ParseResult;
  selectedField: ParsedField | null;
  onSelect: (field: ParsedField | null) => void;
}) {
  // 找到覆盖当前字节偏移的第一个解析字段。
  const ownerAt = (index: number) => result.fields.find((item) => index >= item.offset && index < item.offset + item.length);
  return (
    <div className="byte-map-wrap">
      <div className="byte-ruler" aria-hidden="true">
        {result.rawBytes.map((_, index) => <span key={index}>{index.toString(16).padStart(2, "0").toUpperCase()}</span>)}
      </div>
      <div className="byte-map" aria-label="HEX 字节地图">
        {result.rawBytes.map((value, index) => {
          const owner = ownerAt(index);
          const selected = selectedField && index >= selectedField.offset && index < selectedField.offset + selectedField.length;
          return (
            <button
              className={`byte-chip tone-${owner?.tone ?? "plain"}${selected ? " is-selected" : ""}`}
              key={`${index}-${value}`}
              type="button"
              aria-label={`偏移 ${index}，${hex([value])}${owner ? `，${owner.name}` : ""}`}
              onMouseEnter={() => onSelect(owner ?? null)}
              onFocus={() => onSelect(owner ?? null)}
            >
              {hex([value])}
            </button>
          );
        })}
      </div>
      <div className="byte-selection">
        {selectedField ? <><strong>{selectedField.name}</strong><span>偏移 {selectedField.offset} · {selectedField.length} Bytes · {selectedField.value}{selectedField.unit ? ` ${selectedField.unit}` : ""}</span></> : <span>悬停或聚焦字节，查看对应字段。</span>}
      </div>
    </div>
  );
}

export function ProtocolStudio() {
  // 工作台所有状态都保留在浏览器本地，不会上传原始报文。
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [rawInput, setRawInput] = useState(samples.cjt188.value);
  const [parserId, setParserId] = useState("auto");
  const [intEndian, setIntEndian] = useState<"auto" | "be" | "le">("auto");
  const [result, setResult] = useState<ParseResult | null>(initialResult);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [selectedField, setSelectedField] = useState<ParsedField | null>(null);
  const [message, setMessage] = useState("已载入示例，可直接体验解析结果");
  const [error, setError] = useState("");

  // 主题属于设备本地偏好，刷新页面后继续沿用。
  useEffect(() => {
    const saved = window.localStorage.getItem("eoiot-theme");
    if (saved === "dark" || saved === "light") setTheme(saved);
  }, []);

  // 输入变化时只做轻量语法检查，不自动执行完整协议解析。
  const inputState = useMemo(() => {
    try {
      const bytes = parseHex(rawInput);
      return { valid: true, count: bytes.length, text: bytes.length ? "HEX 格式有效" : "等待输入" };
    } catch (caught) {
      return { valid: false, count: 0, text: caught instanceof Error ? caught.message : "HEX 格式错误" };
    }
  }, [rawInput]);

  /** 切换昼夜主题并写入 localStorage。 */
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    window.localStorage.setItem("eoiot-theme", next);
  };

  /** 把输入交给协议注册表，并同步刷新结果、标签和状态消息。 */
  const parseFrame = () => {
    try {
      const parsed = parseWithRegistry(parseHex(rawInput), parserId, { intEndian });
      setResult(parsed);
      setSelectedField(null);
      setActiveTab("overview");
      setError("");
      setMessage(`${parsed.protocol} · 本地解析成功`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "解析失败，请检查报文。");
    }
  };

  /** 恢复内置 CJ/T 188 示例，便于快速体验和演示。 */
  const loadSample = () => {
    setRawInput(samples.cjt188.value);
    setParserId("auto");
    setError("");
    setMessage("已载入 CJ/T 188 示例报文");
  };

  /** 将逗号、换行和 0x 前缀统一整理为标准空格分隔格式。 */
  const formatInput = () => {
    try {
      setRawInput(hex(parseHex(rawInput)));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法格式化当前内容。");
    }
  };

  // 概览只展示存在且有定义的前 8 个业务指标，避免空卡片。
  const visibleMetrics = result
    ? Object.entries(result.metrics).filter(([key, value]) => metricLabels[key] && value !== null && value !== "—").slice(0, 8)
    : [];

  return (
    <main className="studio-app" data-theme={theme}>
      {/* 顶栏：品牌、工作空间、主题偏好和用户入口。 */}
      <header className="topbar">
        <div className="brand"><span className="brand-mark">EO</span><div><strong>EOIOT</strong><small>Protocol Studio</small></div></div>
        <div className="workspace-switch"><strong>源一物联</strong><span>/ 默认空间</span><b>⌄</b></div>
        <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={theme === "light" ? "切换到夜间模式" : "切换到白天模式"}>
          <span aria-hidden="true">{theme === "light" ? "◐" : "☀"}</span>{theme === "light" ? "夜间模式" : "白天模式"}
        </button>
        <div className="avatar" aria-label="当前用户">WJ</div>
      </header>

      <div className="app-grid">
        {/* 左侧导航为未来协议库、设备云和团队能力预留稳定信息架构。 */}
        <aside className="sidebar">
          <nav aria-label="主导航">
            <p className="nav-title">开发工具</p>
            <button className="nav-item active" type="button"><span>⌁</span><b>协议解析</b></button>
            <button className="nav-item" type="button"><span>◇</span><b>协议库</b><em>{parsers.length}</em></button>
            <button className="nav-item" type="button"><span>▣</span><b>样例帧</b></button>
            <p className="nav-title">设备云</p>
            <button className="nav-item" type="button"><span>⌾</span><b>设备与上报</b><em>后续</em></button>
            <button className="nav-item" type="button"><span>↺</span><b>解析记录</b><em>后续</em></button>
            <p className="nav-title">组织</p>
            <button className="nav-item" type="button"><span>○</span><b>团队成员</b></button>
            <button className="nav-item" type="button"><span>⚙</span><b>设置</b></button>
          </nav>
          <div className="local-note"><span className="secure-dot"/><strong>本地解析模式</strong><p>报文不会上传服务器</p></div>
        </aside>

        {/* 当前首版的核心页面：报文输入与解析结果双栏工作台。 */}
        <section className="page">
          <div className="page-heading">
            <div><p className="eyebrow">METER PROTOCOL DEBUGGER</p><h1>协议解析工作台</h1><span>粘贴设备报文，自动识别协议、定位字段与诊断异常。</span></div>
            <div className="mode-switch"><button className="active" type="button">解析报文</button><button type="button">生成指令 <small>即将支持</small></button></div>
          </div>

          <div className="workbench">
            {/* 输入区包含协议选择、端序、HEX 编辑器及快捷样例。 */}
            <section className="panel input-panel">
              <div className="panel-title"><div><span className="step">01</span><strong>输入原始帧</strong></div><span className="byte-count">{inputState.count} Bytes</span></div>
              <div className="input-body">
                <div className="input-intro"><div><strong>粘贴设备报文</strong><span>自动清洗格式并匹配协议</span></div><span className="privacy-pill">✓ 仅本地处理</span></div>
                <div className="form-grid">
                  <label><span>解析协议</span><select value={parserId} onChange={(event) => setParserId(event.target.value)}><option value="auto">智能识别（推荐）</option>{parsers.map((parser) => <option value={parser.id} key={parser.id}>{parser.name}</option>)}</select></label>
                  <label><span>整数端序</span><select value={intEndian} onChange={(event) => setIntEndian(event.target.value as "auto" | "be" | "le")}><option value="auto">自动</option><option value="be">大端 BE</option><option value="le">小端 LE</option></select></label>
                </div>
                <div className={`hex-editor${!inputState.valid ? " has-error" : ""}`}>
                  <div className="editor-toolbar"><span>HEX / RAW FRAME</span><button type="button" onClick={formatInput}>✦ 智能格式化</button></div>
                  <div className="editor-main"><div className="line-numbers" aria-hidden="true">1<br/>2<br/>3<br/>4<br/>5</div><textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始十六进制报文" placeholder="例如：FE FE 68 10 71 40 ... 16"/></div>
                  <div className="editor-status"><span className={inputState.valid ? "valid" : "invalid"}>{inputState.valid ? "●" : "!"} {inputState.text}</span><span>空格 · 换行 · 逗号 · 0x</span></div>
                </div>
                <div className="input-actions"><button className="parse-button" type="button" onClick={parseFrame}>✦ 识别并解析报文</button><button className="sample-button" type="button" onClick={loadSample}>使用样例</button></div>
                {error ? <p className="inline-error" role="alert">{error}</p> : <p className="input-footnote">解析记录默认不保存，可稍后加入团队样例库。</p>}
              </div>
            </section>

            {/* 所有解析器通过统一 ParseResult 驱动同一套结果界面。 */}
            <section className="panel result-panel">
              <div className="panel-title"><div><span className="step">02</span><strong>解析结果</strong></div><span className="result-state"><i/> {message}</span></div>
              {result ? (
                <>
                  <div className="result-hero">
                    <div className="protocol-identity"><span className="success-mark">✓</span><div><p>识别到协议</p><h2>{result.protocol}</h2><span>{result.manufacturer} · {result.categoryLabel}</span></div></div>
                    <div className="confidence"><span>匹配度</span><strong>{result.confidence}%</strong></div>
                  </div>
                  <div className="primary-metrics"><div><span>核心读数</span><strong>{result.coreValue}</strong></div><div><span>表号</span><strong>{result.meterNo}</strong></div><div><span>数据标识 DI</span><strong>{result.dataIdentifier}</strong></div><div><span>控制码</span><strong>{result.controlCode}</strong></div></div>
                  {/* 标签页按需展示同一份解析结果，避免同时堆叠大量信息。 */}
                  <div className="tabs" role="tablist" aria-label="解析结果详情">{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}{tab.id === "diagnostics" && <em>{result.diagnostics.length}</em>}</button>)}</div>
                  <div className="tab-content">
                    {activeTab === "overview" && <div className="metric-grid">{visibleMetrics.map(([key, value]) => <article key={key}><span>{metricLabels[key].label}</span><strong>{formatMetric(value, metricLabels[key].unit)}</strong></article>)}</div>}
                    {activeTab === "fields" && <div className="table-scroll"><table><thead><tr><th>偏移</th><th>字段</th><th>原始字节</th><th>解析值</th><th>说明</th></tr></thead><tbody>{result.fields.map((item) => <tr key={`${item.offset}-${item.name}`} onMouseEnter={() => setSelectedField(item)}><td>{item.offset}–{item.offset + Math.max(item.length - 1, 0)}</td><td>{item.name}</td><td><code>{item.raw || "—"}</code></td><td><strong>{item.value}</strong>{item.unit ? ` ${item.unit}` : ""}</td><td>{item.note ?? "—"}</td></tr>)}</tbody></table></div>}
                    {activeTab === "bytes" && <ByteMap result={result} selectedField={selectedField} onSelect={setSelectedField}/>} 
                    {activeTab === "history" && (result.history.length ? <div className="table-scroll"><table><thead><tr><th>采集时间</th><th>正向累计</th><th>反向累计</th><th>瞬时流量</th><th>压力</th></tr></thead><tbody>{result.history.map((item, index) => <tr key={`${item.collectTime}-${index}`}><td>{item.collectTime}</td><td>{item.forwardFlow ?? "—"}</td><td>{item.reverseFlow ?? "—"}</td><td>{item.instantFlow ?? "—"}</td><td>{item.pressure ?? "—"}</td></tr>)}</tbody></table></div> : <div className="empty-tab"><span>↺</span><strong>这条报文没有历史数据</strong><p>包含 9021、9023 或 9025 历史记录的报文会显示在这里。</p></div>)}
                    {activeTab === "diagnostics" && <div className="diagnostic-list">{result.diagnostics.map((item, index) => <article className={`diag-${item.level}`} key={`${item.text}-${index}`}><span>{item.level === "ok" ? "✓" : item.level === "warn" ? "!" : "×"}</span><div><strong>{item.level === "ok" ? "检查通过" : item.level === "warn" ? "需要关注" : "解析错误"}</strong><p>{item.text}</p></div></article>)}</div>}
                    {activeTab === "json" && <div className="json-view"><button type="button" onClick={() => navigator.clipboard?.writeText(JSON.stringify(result, null, 2))}>复制 JSON</button><pre>{JSON.stringify(result, null, 2)}</pre></div>}
                  </div>
                </>
              ) : <div className="result-empty"><span>68</span><h2>等待数据帧</h2><p>输入原始帧后，这里会显示协议识别、业务读数和异常诊断。</p></div>}
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
