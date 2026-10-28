"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { hex, parseHex } from "@/lib/protocols/bytes";
import { formatHexIfValid } from "@/lib/protocols/format-input";
import { buildAnalysisSummary } from "@/lib/protocols/analysis";
import { parseWithRegistry, parsers, validateWithRegistry } from "@/lib/protocols/registry";
import { sampleList, samples } from "@/lib/protocols/samples";
import { buildWotmanIpCommand } from "@/lib/protocols/wotman-command";
import { buildWotmanSyncCommand } from "@/lib/protocols/wotman-sync-command";
import {
  buildCollectionIntervalCommand,
  buildUploadScheduleCommand,
  buildValveCommand,
  type ValveAction,
} from "@/lib/protocols/wotman-control-command";
import {
  buildJoymeterCommand,
  type JoymeterCommandKind,
  type JoymeterValveAction,
} from "@/lib/protocols/joymeter-command";
import { downloadXlsx } from "@/lib/export-xlsx";
import { formatModbusValue } from "@/lib/protocols/modbus";
import { ThemedSelect } from "./components/themed-select";
import { ChecksumTools } from "./components/checksum-tools";
import { CommandDirectory, type DirectoryGroup } from "./components/command-directory";
import { useParseRecords } from "./hooks/use-parse-records";
import { RecordsPage } from "./components/records-page";
import { WaterStatusPanel } from "./components/water-status-panel";
import { WaterOverview } from "./components/water-overview";
import { ReadingFocus } from "./components/reading-focus";
import { ElectricProcess } from "./components/electric-process";
import { CopyButton } from "./components/copy-button";
import { createParseRecord, type ParseRecord } from "@/lib/records/record-store";
import type {
  ModbusByteOrder,
  ModbusDataType,
  ModbusDecodeConfig,
  ParseOptions,
  ParseResult,
  ParsedField,
} from "@/lib/protocols/types";

const defaultModbusConfig: ModbusDecodeConfig = {
  rangeMode: "all",
  dataType: "UINT16",
  byteOrder: "AB",
  scale: 1,
  unit: "",
  registerOffset: 0,
  valueCount: 1,
  label: "解析值",
  decimals: 2,
};
function modbusConfigToForm(config: ModbusDecodeConfig) {
  return {
    ...config,
    rangeMode: config.rangeMode ?? "custom",
    model: config.model ?? "",
    registerAddress: config.registerAddress === undefined ? "" : String(config.registerAddress),
    scale: String(config.scale),
    registerOffset: String(config.registerOffset),
    valueCount: String(config.valueCount),
    decimals: config.decimals === undefined ? "auto" : String(config.decimals),
  };
}
const modbusNumericInput = (value: string) => (value.trim() === "" ? NaN : Number(value));

type TabId = "overview" | "fields" | "bytes" | "history" | "diagnostics" | "json";
type AppView = "studio" | "commands" | "library" | "samples" | "records";
type CommandType = "network" | "sync" | "valve" | "schedule" | "interval";
type CommandVendor = "wotman" | "joymeter";
type ActionFeedback =
  | "copy-input"
  | "copy-explanation"
  | "paste"
  | "format"
  | "clear"
  | "copy-json"
  | "export-json"
  | "copy-command"
  | "export-command"
  | null;
type CommandGenerationMode = "single" | "batch";

const defaultCommandInput = {
  meterAddress: "00430500003821",
  primaryIp: "60.205.218.69",
  primaryPort: "6118",
  apn: "CMNET",
};
const defaultJoymeterInput = {
  meterAddress: "00510500088954",
  ip: "60.205.218.69",
  port: "6118",
  baseReading: "12345678",
  valveAction: "open" as JoymeterValveAction,
  startHour: "3",
  maxRandomSeconds: "3600",
  reportPeriodHours: "6",
};

const commandProtocols: Array<{
  id: CommandVendor;
  manufacturer: string;
  product: string;
  scope: string;
  keywords: string;
}> = [
  {
    id: "wotman",
    manufacturer: "大口径水表 · 4G",
    product: "采集器 / 大口径水表",
    scope: "NB-IoT 仪表采集器协议",
    keywords: "大口径水表 · 4G 水表 采集器 大口径 NB 8110 A016 8104 8105",
  },
  {
    id: "joymeter",
    manufacturer: "小口径水表 · 4G",
    product: "后付费 NB & 4G 水表",
    scope: "CJ/T 188 扩展写入协议",
    keywords: "小口径水表 · 4G 后付费 水表 A171 A180 A181 A182 A183 A184",
  },
];

const commandCatalog: Record<
  CommandVendor,
  Array<{
    group: string;
    items: Array<{ id: string; label: string; di: string; keywords: string }>;
  }>
> = {
  wotman: [
    {
      group: "通信配置",
      items: [
        { id: "network", label: "写 IP / 端口", di: "8110H", keywords: "通信 服务器 APN IP 端口" },
      ],
    },
    {
      group: "计量设置",
      items: [{ id: "sync", label: "写机电同步", di: "A016H", keywords: "累计流量 同步 底数" }],
    },
    {
      group: "设备控制",
      items: [{ id: "valve", label: "阀门控制", di: "A017H", keywords: "开阀 关阀" }],
    },
    {
      group: "数据采集",
      items: [
        { id: "schedule", label: "自动上传时间", di: "8104H", keywords: "上传 时间 定时" },
        { id: "interval", label: "采集间隔", di: "8105H", keywords: "采集 间隔 分钟" },
      ],
    },
  ],
  joymeter: [
    {
      group: "通信配置",
      items: [
        { id: "network", label: "写 IP / 端口", di: "A184H", keywords: "通信 UDP 服务器 IP 端口" },
      ],
    },
    {
      group: "计量设置",
      items: [{ id: "base", label: "写基表读数", di: "A171H", keywords: "底数 累计量 读数" }],
    },
    {
      group: "设备控制",
      items: [{ id: "valve", label: "开关阀", di: "A017H", keywords: "开阀 关阀" }],
    },
    {
      group: "上报配置",
      items: [
        { id: "reporting", label: "上报参数集合", di: "A180H", keywords: "上报 参数 集合" },
        { id: "start", label: "上报起始时间", di: "A181H", keywords: "上报 起始 时间" },
        { id: "random", label: "最大随机间隔", di: "A182H", keywords: "上报 随机 间隔 秒" },
        { id: "period", label: "上报周期", di: "A183H", keywords: "上报 周期 小时" },
      ],
    },
  ],
};

/** 工具栏使用统一的线性图标，避免不同平台的 Emoji 造成视觉尺寸不一致。 */
function ToolIcon({
  name,
}: {
  name: "paste" | "format" | "clear" | "copy" | "download" | "check" | "code";
}) {
  const paths = {
    paste: (
      <>
        <path d="M9 5h6" />
        <path d="M9 3h6v4H9z" />
        <path d="M7 5H5v16h14V5h-2" />
      </>
    ),
    format: (
      <>
        <path d="M4 6h16M4 12h10M4 18h7" />
        <path d="m16 17 2 2 3-4" />
      </>
    ),
    clear: (
      <>
        <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="11" height="12" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
        <path d="M5 19h14" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    code: (
      <>
        <path d="m9 8-4 4 4 4m6-8 4 4-4 4" />
      </>
    ),
  };
  return (
    <svg
      className="tool-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

/**
 * 两色协议窗口：圆点和短线复用底色，深浅主题通过品牌变量同步换色。
 */
function BrandMark() {
  return (
    <svg className="brand-mark" aria-hidden="true" viewBox="0 0 40 40">
      <rect className="brand-logo-card" x="1" y="1" width="38" height="38" rx="10" />
      <rect className="brand-logo-window" x="9" y="13" width="22" height="16" rx="3.2" />
      <circle className="brand-logo-cutout" cx="13.6" cy="23.8" r="1.3" />
      <rect className="brand-logo-cutout" x="17.4" y="22.5" width="10.4" height="2.6" rx="1.3" />
    </svg>
  );
}

/** 侧栏导航统一使用 18px 线性 SVG，保证图标线宽、基线和文字间距一致。 */
function NavIcon({
  name,
}: {
  name: "parser" | "command" | "library" | "sample" | "history" | "device" | "team";
}) {
  const paths = {
    parser: (
      <>
        <path d="M5 3h10l4 4v14H5z" />
        <path d="M15 3v5h5M8 12h8M8 16h5" />
      </>
    ),
    command: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3M13 15h4" />
      </>
    ),
    library: (
      <>
        <path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
        <path d="M8 4v16M11 8h5M11 12h5" />
      </>
    ),
    sample: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M8 8h3v3H8zM13 8h3v3h-3zM8 13h3v3H8zM13 13h3v3h-3z" />
      </>
    ),
    history: (
      <>
        <path d="M4 12a8 8 0 1 0 2.34-5.66L4 8.68" />
        <path d="M4 4v4.68h4.68M12 8v5l3 2" />
      </>
    ),
    device: (
      <>
        <rect x="6" y="3" width="12" height="18" rx="2" />
        <path d="M9 7h6M9 11h6M10 17h4" />
      </>
    ),
    team: (
      <>
        <path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
        <circle cx="9.5" cy="7" r="4" />
        <path d="M17 11a4 4 0 0 1 4 4v2M17 3.5a4 4 0 0 1 0 7" />
      </>
    ),
  };
  return (
    <svg
      className="nav-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
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
  "modbus-rtu": [
    "03 / 04 读取请求与应答",
    "16 / 32 位有符号及无符号整数",
    "FLOAT32 浮点数",
    "字节序与缩放因子",
    "自定义单位及解析位置",
    "CRC16 校验",
  ],
  "dlt645-energy": [
    "累计电量及费率 1–8",
    "尖峰平谷（按表内配置）",
    "组合 / 正向 / 反向有功",
    "减 33H 与 BCD 解码",
    "实际返回费率合计核对",
    "CS 校验",
  ],
  "joymeter-command": [
    "A184 写服务器",
    "A171 写基表读数",
    "A017 开关阀",
    "A180–A183 上报参数",
    "24H 下行 / A4H 应答",
    "字段反向解析",
  ],
  "wotman-command": [
    "8110 写通信参数",
    "A016 写机电同步",
    "A017 阀门控制",
    "8104 上传时间",
    "8105 采集间隔",
    "字段反向解析",
  ],
  "joymeter-mbus": [
    "901F 抄表请求/应答",
    "当前与结算累计量",
    "两字节状态字",
    "阀门与 12 项告警",
    "CS 校验",
  ],
  "cjt188-small": ["4G 9020 主动上报", "10H–19H 水表类型", "累计与反向流量", "网络状态", "CS 校验"],
  "wotman-big": ["9021 / 9023 / 9025", "历史数据", "压力温度", "设备身份", "业务告警"],
};

const protocolCenterMeta: Record<string, { vendor: string; product: string; short: string }> = {
  "modbus-rtu": { vendor: "Modbus", product: "RTU 自定义寄存器解析", short: "RTU" },
  "dlt645-energy": { vendor: "DL/T 645", product: "单费率 / 多费率电表", short: "电表" },
  "joymeter-command": { vendor: "小口径水表 · 4G", product: "4G 水表写入指令", short: "4G 写入" },
  "joymeter-mbus": { vendor: "小口径水表 · MBus", product: "MBus 抄表协议", short: "MBus" },
  "cjt188-small": { vendor: "小口径水表 · 4G", product: "4G 小口径水表", short: "4G 水表" },
  "wotman-command": { vendor: "大口径水表 · 4G", product: "大口径下行写入指令", short: "写入指令" },
  "wotman-big": { vendor: "大口径水表 · 4G", product: "大口径水表上报协议", short: "大口径水表" },
};

const protocolCenterVendors = [
  "小口径水表 · 4G",
  "小口径水表 · MBus",
  "大口径水表 · 4G",
  "DL/T 645",
  "Modbus",
];

function formatMetric(value: string | number | null, unit?: string) {
  if (value === null || value === "—") return "—";
  const formatted =
    typeof value === "number" ? value.toLocaleString("zh-CN", { maximumFractionDigits: 3 }) : value;
  return unit ? `${formatted} ${unit}` : formatted;
}

/** 复用字段解释的标准五列表格，保持基础字段和后续设备字段列宽一致。 */
function FieldTable({
  fields,
  selectedField,
  onSelect,
}: {
  fields: ParsedField[];
  selectedField: ParsedField | null;
  onSelect: (field: ParsedField) => void;
}) {
  return (
    <div className="table-scroll field-table-scroll">
      <table className="field-table">
        <colgroup>
          <col className="field-col-offset" />
          <col className="field-col-name" />
          <col className="field-col-raw" />
          <col className="field-col-value" />
          <col className="field-col-note" />
        </colgroup>
        <thead>
          <tr>
            <th>偏移</th>
            <th>字段</th>
            <th>原始字节</th>
            <th>解析值</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((item) => (
            <tr
              className={selectedField === item ? "is-selected" : ""}
              key={`${item.offset}-${item.name}`}
              onMouseEnter={() => onSelect(item)}
              onClick={() => onSelect(item)}
            >
              <td>
                {item.offset}–{item.offset + Math.max(item.length - 1, 0)}
              </td>
              <td>{item.name}</td>
              <td>
                <code>{item.raw || "—"}</code>
              </td>
              <td>
                <strong>{item.value}</strong>
                {item.unit ? ` ${item.unit}` : ""}
              </td>
              <td>{item.note ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 长报文按“报文结构 / 历史记录 / 当前与设备”分区浏览。
 * 历史记录采用记录选择器与单条详情，避免 12 条记录全部纵向展开。
 */
function FieldExplanation({
  result,
  selectedField,
  onSelect,
}: {
  result: ParseResult;
  selectedField: ParsedField | null;
  onSelect: (field: ParsedField) => void;
}) {
  const [section, setSection] = useState<"structure" | "history" | "current">("structure");
  const [activeRecord, setActiveRecord] = useState(1);
  const [currentGroup, setCurrentGroup] = useState<"measurement" | "network" | "status">(
    "measurement",
  );
  const historyPattern = /^历史第\s+(\d+)\s+条/;
  const historyIndexes = result.fields
    .map((item, index) => (historyPattern.test(item.name) ? index : -1))
    .filter((index) => index >= 0);
  if (!historyIndexes.length)
    return <FieldTable fields={result.fields} selectedField={selectedField} onSelect={onSelect} />;

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
  const selectedHistory =
    groups.find(([recordNumber]) => recordNumber === activeRecord) ?? groups[0];
  const selectedHistoryItem = selectedHistory ? result.history[selectedHistory[0] - 1] : undefined;
  const networkPattern = /信号|覆盖|PCI|IMEI|IMSI/i;
  const measurementPattern = /当前|电压/;
  const currentGroups = {
    measurement: afterHistory.filter(
      (item) => measurementPattern.test(item.name) && !networkPattern.test(item.name),
    ),
    network: afterHistory.filter((item) => networkPattern.test(item.name)),
    status: afterHistory.filter(
      (item) => !measurementPattern.test(item.name) && !networkPattern.test(item.name),
    ),
  };
  const currentOptions = [
    { id: "measurement" as const, label: "当前计量", fields: currentGroups.measurement },
    { id: "network" as const, label: "网络身份", fields: currentGroups.network },
    { id: "status" as const, label: "状态校验", fields: currentGroups.status },
  ].filter((item) => item.fields.length > 0);
  const activeCurrent =
    currentOptions.find((item) => item.id === currentGroup) ?? currentOptions[0];
  const historyFieldLabel = (name: string) => name.replace(/^历史第\s+\d+\s+条[·：:\s]*/, "");

  return (
    <div className="field-explanation">
      <div className="field-section-tabs" role="tablist" aria-label="字段解释分区">
        <button
          className={section === "structure" ? "active" : ""}
          type="button"
          role="tab"
          aria-selected={section === "structure"}
          onClick={() => setSection("structure")}
        >
          <span>报文结构</span>
          <em>{beforeHistory.length}</em>
        </button>
        <button
          className={section === "history" ? "active" : ""}
          type="button"
          role="tab"
          aria-selected={section === "history"}
          onClick={() => setSection("history")}
        >
          <span>历史记录</span>
          <em>{groups.length}</em>
        </button>
        {afterHistory.length > 0 && (
          <button
            className={section === "current" ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={section === "current"}
            onClick={() => setSection("current")}
          >
            <span>当前与设备</span>
            <em>{afterHistory.length}</em>
          </button>
        )}
      </div>

      {section === "structure" && (
        <FieldTable fields={beforeHistory} selectedField={selectedField} onSelect={onSelect} />
      )}

      {section === "history" && selectedHistory && (
        <section className="history-browser" aria-label="历史采集记录">
          <header>
            <div>
              <strong>历史采集记录</strong>
              <span>
                {is9025
                  ? "选择一条记录查看 A / B / C / D 四项明细"
                  : `${result.dataIdentifier} 每条为一个采集时点累计量`}
              </span>
            </div>
            <em>
              {groups.length} 条 · {bytesPerRecord} Bytes / 条
            </em>
          </header>
          <div className="history-record-picker" role="list" aria-label="选择历史记录">
            {groups.map(([recordNumber, fields]) => {
              const historyItem = result.history[recordNumber - 1];
              const primaryField =
                fields.find((item) => item.name.includes("正向累计")) ?? fields[0];
              const displayTime = historyItem?.collectTime?.split(" ").at(-1) ?? "—";
              return (
                <button
                  className={selectedHistory[0] === recordNumber ? "active" : ""}
                  key={recordNumber}
                  type="button"
                  role="listitem"
                  onClick={() => {
                    setActiveRecord(recordNumber);
                    onSelect(primaryField);
                  }}
                >
                  <span>第 {recordNumber} 条</span>
                  <strong>{displayTime}</strong>
                  <small>
                    {primaryField.value}
                    {primaryField.unit ? ` ${primaryField.unit}` : ""}
                  </small>
                </button>
              );
            })}
          </div>
          <article className="history-record-detail">
            <header>
              <div>
                <strong>第 {selectedHistory[0]} 条详情</strong>
                <span>{selectedHistoryItem?.collectTime ?? "采集时间未提供"}</span>
              </div>
              <code>
                偏移 {selectedHistory[1][0].offset}–
                {(selectedHistory[1].at(-1) ?? selectedHistory[1][0]).offset +
                  (selectedHistory[1].at(-1) ?? selectedHistory[1][0]).length -
                  1}
              </code>
            </header>
            <div className="history-detail-grid">
              {selectedHistory[1].map((item) => (
                <button
                  className={selectedField === item ? "is-selected" : ""}
                  key={`${item.offset}-${item.name}`}
                  type="button"
                  onMouseEnter={() => onSelect(item)}
                  onFocus={() => onSelect(item)}
                  onClick={() => onSelect(item)}
                >
                  <span>{historyFieldLabel(item.name)}</span>
                  <strong>
                    {item.value}
                    {item.unit ? ` ${item.unit}` : ""}
                  </strong>
                  <code>{item.raw}</code>
                </button>
              ))}
            </div>
          </article>
        </section>
      )}

      {section === "current" && activeCurrent && (
        <section className="current-field-browser">
          <div className="current-field-tabs" role="tablist" aria-label="当前值与设备字段分组">
            {currentOptions.map((item) => (
              <button
                className={activeCurrent.id === item.id ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={activeCurrent.id === item.id}
                key={item.id}
                onClick={() => setCurrentGroup(item.id)}
              >
                {item.label}
                <em>{item.fields.length}</em>
              </button>
            ))}
          </div>
          <FieldTable
            fields={activeCurrent.fields}
            selectedField={selectedField}
            onSelect={onSelect}
          />
        </section>
      )}
    </div>
  );
}

function initialResult(): ParseResult | null {
  try {
    return parseWithRegistry(parseHex(samples.cjt188.value));
  } catch {
    return null;
  }
}

/** 字节地图与字段表共享选中状态，便于从业务字段反查原始报文。 */
function ByteMap({
  result,
  selectedField,
  onSelect,
}: {
  result: ParseResult;
  selectedField: ParsedField | null;
  onSelect: (field: ParsedField | null) => void;
}) {
  const [hoveredByte, setHoveredByte] = useState<{ index: number; x: number; y: number } | null>(
    null,
  );
  const ownerAt = (index: number) =>
    result.fields.find((item) => index >= item.offset && index < item.offset + item.length);
  const hoveredOwner = hoveredByte ? ownerAt(hoveredByte.index) : null;
  const showByteTooltip = (element: HTMLButtonElement, index: number) => {
    const rect = element.getBoundingClientRect();
    const safeX = Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150);
    setHoveredByte({ index, x: safeX, y: rect.top });
  };
  return (
    <div className="byte-map-wrap">
      <div className="byte-map" aria-label="HEX 字节地图">
        {result.rawBytes.map((value, index) => {
          const owner = ownerAt(index);
          const selected =
            selectedField &&
            index >= selectedField.offset &&
            index < selectedField.offset + selectedField.length;
          return (
            <button
              aria-label={`偏移 ${index}，字节 ${hex([value])}${owner ? `，${owner.name}` : "，未归属字段"}`}
              className={`byte-chip tone-${owner?.tone ?? "plain"}${selected ? " is-selected" : ""}`}
              key={`${index}-${value}`}
              type="button"
              onMouseEnter={(event) => {
                onSelect(owner ?? null);
                showByteTooltip(event.currentTarget, index);
              }}
              onMouseLeave={() => setHoveredByte(null)}
              onFocus={(event) => {
                onSelect(owner ?? null);
                showByteTooltip(event.currentTarget, index);
              }}
              onBlur={() => setHoveredByte(null)}
            >
              <small>{index.toString(16).padStart(2, "0").toUpperCase()}</small>
              {hex([value])}
            </button>
          );
        })}
      </div>
      {hoveredByte && (
        <div
          className="byte-hover-card"
          role="tooltip"
          style={{ left: hoveredByte.x, top: hoveredByte.y }}
        >
          <header>
            <strong>{hoveredOwner?.name ?? "未归属字段"}</strong>
            <code>
              偏移 {hoveredByte.index} · {hex([result.rawBytes[hoveredByte.index]])}
            </code>
          </header>
          {hoveredOwner && (
            <>
              <p>
                <span>解析值</span>
                <strong>
                  {hoveredOwner.value}
                  {hoveredOwner.unit ? ` ${hoveredOwner.unit}` : ""}
                </strong>
              </p>
              <small>
                {hoveredOwner.note ??
                  `字段范围 ${hoveredOwner.offset}–${hoveredOwner.offset + hoveredOwner.length - 1}`}
              </small>
            </>
          )}
        </div>
      )}
      <div className="byte-selection">
        {selectedField ? (
          <>
            <strong>{selectedField.name}</strong>
            <span>
              偏移 {selectedField.offset} · {selectedField.length} Bytes · {selectedField.value}
              {selectedField.unit ? ` ${selectedField.unit}` : ""}
            </span>
          </>
        ) : (
          <span>悬停或聚焦字节，查看所属字段和偏移。</span>
        )}
      </div>
    </div>
  );
}

function ElectricReadings({ result }: { result: ParseResult }) {
  const rateItems =
    result.metrics.readingMode === "多费率电量"
      ? (result.overviewSections
          .find((section) => section.id === "energy")
          ?.items.filter((item) => item.key !== "totalEnergy") ?? [])
      : [];
  const hasRates = rateItems.length > 0;
  if (!hasRates) return null;
  const rateTotal = rateItems.reduce((sum, item) => sum + Number(item.value ?? 0), 0);
  const canShowShare =
    rateTotal > 0 && rateItems.every((item) => typeof item.value === "number" && item.value >= 0);
  const difference = Number(result.metrics.tariffDifference ?? 0);
  const energy = (value: string | number | null | undefined) =>
    typeof value === "number"
      ? value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";
  return (
    <section className="electric-readings" aria-label="电表读数">
      <header className="electric-section-heading">
        <h3>
          {hasRates
            ? "分费率电量"
            : Number(result.metrics.rate) > 0
              ? "费率电量解析"
              : "累计电量解析"}
        </h3>
        <span className="electric-check">
          <ToolIcon name="check" />
          帧校验通过
        </span>
      </header>
      {!hasRates && (
        <p className="electric-overview-note">
          {result.controlCode === "11H"
            ? "读数据请求，等待电表应答。"
            : "本帧返回的单项电量已在顶部显示，未包含完整费率数据块。"}
        </p>
      )}
      {hasRates && (
        <>
          {canShowShare && (
            <div
              className="tariff-share"
              role="img"
              aria-label={`返回费率电量构成，合计 ${energy(rateTotal)} kWh；${rateItems.map((item) => `${item.label} ${((Number(item.value) / rateTotal) * 100).toFixed(1)}%`).join("，")}`}
            >
              <div className="tariff-share-track">
                {rateItems.map((item) => (
                  <span
                    key={item.key}
                    className={`share-${item.key}`}
                    style={{ width: `${(Number(item.value) / rateTotal) * 100}%` }}
                    title={`${item.label} ${energy(item.value)} kWh`}
                  />
                ))}
              </div>
              <small>返回费率电量构成 · 按各费率合计计算</small>
            </div>
          )}
          <dl className="electric-rates">
            {rateItems.map((item) => (
              <div key={item.key} className={`tariff-${item.key}`}>
                <dt>
                  <i aria-hidden="true" />
                  {item.label}
                </dt>
                <dd>
                  <strong>{energy(item.value)}</strong>
                  <span>kWh</span>
                  {canShowShare && (
                    <em className="tariff-share-percent">
                      {((Number(item.value) / rateTotal) * 100).toFixed(1)}%
                    </em>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <div className={`electric-reconciliation${difference !== 0 ? " has-difference" : ""}`}>
            <span>
              费率合计 <strong>{energy(result.metrics.tariffSum)} kWh</strong>
            </span>
            <span>
              {difference === 0 ? (
                "与累计用量一致"
              ) : (
                <>
                  与累计量差值{" "}
                  <strong>
                    {difference > 0 ? "+" : ""}
                    {energy(difference)} kWh
                  </strong>
                </>
              )}
            </span>
          </div>
          {difference !== 0 && (
            <p className="electric-difference-note">
              帧校验已通过。累计用量与返回费率合计存在差值，请核对表内费率配置。
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ElectricReportDetails({
  result,
  copied,
  onCopy,
}: {
  result: ParseResult;
  copied: boolean;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="electric-report-overview">
      <ElectricProcess result={result} copied={copied} onCopy={onCopy} />
      {(result.metrics.readingMode === "多费率电量" || result.controlCode === "11H") && (
        <p className="electric-overview-note">
          {result.metrics.readingMode === "多费率电量"
            ? "费率 1–4 按既有电表配置对应尖、峰、平、谷；其他型号请核对费率配置。"
            : result.controlCode === "11H"
              ? "当前为抄读请求帧，电量将在电表应答帧中返回。"
              : "当前报文返回单项电量，不推断其他费率值。"}
        </p>
      )}
      <details
        className="electric-report-details"
        key={`${result.meterNo}-${result.dataIdentifier}-${result.rawBytes.length}`}
      >
        <summary>
          报文信息
          <span>
            {result.rawBytes.length} Bytes · DI {result.dataIdentifier}
          </span>
        </summary>
        <dl>
          {[
            ["协议", "DL/T 645-2007"],
            ["数据标识 DI", result.dataIdentifier],
            ["控制码", result.controlCode],
            ["数据域长度", `${result.dataLength} Bytes`],
            ["帧长度", `${result.rawBytes.length} Bytes`],
            ["已识别字段", `${result.fields.length} 项`],
            ["报文用途", result.controlCode === "11H" ? "读数据请求" : "读数据应答"],
            ["校验和 CS", hex([result.rawBytes[result.rawBytes.length - 2]])],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

function ModbusOverview({ result }: { result: ParseResult }) {
  const values = result.fields.filter((item) => item.tone === "value");
  const raw = result.fields.filter((item) => item.name.startsWith("原始寄存器"));
  const parameters =
    result.overviewSections.find((section) => section.id === "modbus")?.items ?? [];
  return (
    <div className="modbus-overview">
      {result.diagnostics
        .filter((item) => item.level === "bad")
        .map((item) => (
          <p className="modbus-config-error" role="alert" key={item.text}>
            {item.text}
          </p>
        ))}
      {values.length === 1 && (
        <section className="modbus-conversion">
          <h3>换算过程</h3>
          <div className="modbus-source-bytes">
            <span>原始字节</span>
            <code>{values[0].raw}</code>
          </div>
          <p>{values[0].note}</p>
        </section>
      )}
      {values.length > 1 && (
        <section className="modbus-conversion">
          <h3>解析数据</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>应答内位置</th>
                  <th>名称</th>
                  <th>原始字节</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {values.map((item) => (
                  <tr key={item.offset}>
                    <td>{(item.offset - 3) / 2}</td>
                    <td>{item.name}</td>
                    <td>
                      <code>{item.raw}</code>
                    </td>
                    <td>
                      {item.value} {item.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {!values.length && raw.length > 0 && (
        <section className="modbus-conversion">
          <h3>原始寄存器</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>应答内位置</th>
                  <th>HEX</th>
                  <th>UINT16 原值</th>
                </tr>
              </thead>
              <tbody>
                {raw.map((item) => (
                  <tr key={item.offset}>
                    <td>{(item.offset - 3) / 2}</td>
                    <td>
                      <code>{item.raw}</code>
                    </td>
                    <td>{item.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <details open className="electric-report-details">
        <summary>报文与解析参数</summary>
        <dl>
          {parameters
            .filter((item) => item.value !== null)
            .map((item) => (
              <div key={item.key}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
        </dl>
      </details>
    </div>
  );
}

export function ProtocolStudio() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [view, setView] = useState<AppView>("studio");
  const [rawInput, setRawInput] = useState(samples.cjt188.value);
  const [commandInput, setCommandInput] = useState({ ...defaultCommandInput });
  const [commandVendor, setCommandVendor] = useState<CommandVendor>("wotman");
  const [commandWorkspace, setCommandWorkspace] = useState("device");
  const [commandType, setCommandType] = useState<CommandType>("network");
  const [joymeterCommandType, setJoymeterCommandType] = useState<JoymeterCommandKind>("network");
  const [joymeterInput, setJoymeterInput] = useState({ ...defaultJoymeterInput });
  const [commandGenerationMode, setCommandGenerationMode] =
    useState<CommandGenerationMode>("single");
  const [batchMeterInput, setBatchMeterInput] = useState("");
  const [syncCommandInput, setSyncCommandInput] = useState({
    meterAddress: "00430500003931",
    cumulativeFlow: "10",
  });
  const [valveCommandInput, setValveCommandInput] = useState<{
    meterAddress: string;
    action: ValveAction;
  }>({ meterAddress: "00430500003931", action: "open" });
  const [scheduleMeterAddress, setScheduleMeterAddress] = useState("00430500003931");
  const [uploadSchedule, setUploadSchedule] = useState<Array<[string, string]>>(() =>
    Array.from({ length: 24 }, () => ["0", "30"]),
  );
  const [intervalCommandInput, setIntervalCommandInput] = useState({
    meterAddress: "00430500003931",
    intervalMinutes: "60",
  });
  const [result, setResult] = useState<ParseResult | null>(initialResult);
  const electricResult = result?.category === "electric";
  const [modbusMode, setModbusMode] = useState<"custom" | "raw">("custom");
  const [modbusForm, setModbusForm] = useState(() => modbusConfigToForm(defaultModbusConfig));
  const [modbusFrame, setModbusFrame] = useState<number[] | null>(null);
  const modbusBytesPerValue = modbusForm.dataType.endsWith("16") ? 2 : 4;
  const modbusAutoCount = modbusFrame ? modbusFrame[2] / modbusBytesPerValue : 0;
  const [modbusDirty, setModbusDirty] = useState(false);
  const [modbusConfigError, setModbusConfigError] = useState("");
  const modbusOptions: ParseOptions =
    modbusMode === "raw"
      ? {}
      : {
          modbusDecode: {
            ...modbusForm,
            registerAddress:
              modbusForm.registerAddress.trim() === ""
                ? undefined
                : modbusNumericInput(modbusForm.registerAddress),
            scale: modbusNumericInput(modbusForm.scale),
            registerOffset: modbusNumericInput(modbusForm.registerOffset),
            valueCount: modbusNumericInput(modbusForm.valueCount),
            decimals:
              modbusForm.decimals === "auto" ? undefined : modbusNumericInput(modbusForm.decimals),
          },
        };
  const resetModbusResult = () => {
    setModbusDirty(true);
    setModbusConfigError("");
    setMessage("参数已修改，待应用");
  };
  const updateModbusForm = (patch: Partial<typeof modbusForm>) => {
    setModbusForm((current) => ({ ...current, ...patch }));
    resetModbusResult();
  };
  const invalidateInput = () => {
    setResult(null);
    setModbusFrame(null);
    setModbusDirty(false);
    setModbusConfigError("");
    setSelectedField(null);
    setError("");
    setMessage("等待解析");
  };
  const coreReadout =
    result?.protocolId === "modbus-rtu" &&
    typeof result.metrics.decodedValue === "number" &&
    result.metrics.decodedCount === 1
      ? [
          "",
          formatModbusValue(
            result.metrics.decodedValue,
            typeof result.metrics.decodeConfig === "string"
              ? (JSON.parse(result.metrics.decodeConfig) as ModbusDecodeConfig).decimals
              : undefined,
          ),
          String(result.metrics.unit),
        ]
      : result?.coreValue.match(/^(-?[\d,.]+)\s+(kWh|m³)$/);
  const resultTabs =
    electricResult || result?.protocolId === "modbus-rtu" || !result?.history.length
      ? tabs.filter((tab) => tab.id !== "history")
      : tabs;
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [selectedField, setSelectedField] = useState<ParsedField | null>(null);
  const {
    records,
    notice: recordStorageNotice,
    addRecord,
    removeRecord,
    clearRecords: clearStoredRecords,
  } = useParseRecords();
  const [recordSearch, setRecordSearch] = useState("");
  const [recordProtocol, setRecordProtocol] = useState("");
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [message, setMessage] = useState("已载入示例，可直接体验解析结果");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback>(null);
  const [protocolCenterSearch, setProtocolCenterSearch] = useState("");
  const [selectedProtocolId, setSelectedProtocolId] = useState("joymeter-mbus");
  const [selectedSampleId, setSelectedSampleId] = useState(samples.joymeterMbus.id);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 主题读取失败不阻止使用；记录恢复由独立存储层处理。 */
  useEffect(() => {
    try {
      const savedTheme = window.localStorage.getItem("eoiot-theme");
      if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme);
    } catch {
      /* 使用默认主题，不将浏览器存储异常当作解析失败。 */
    }
  }, []);

  /** 同步文档主题，让视口滚动条和原生控件跟随工作区。 */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
      return {
        count: bytes.length,
        text: bytes.length ? "待解析 · 输入完成后点击解析报文" : "请输入或粘贴 HEX 报文",
      };
    } catch {
      const compact = rawInput.replace(/0x/gi, "").replace(/[，,;；:_\-\s]+/g, "");
      return { count: Math.floor(compact.length / 2), text: "输入中 · 等待完整报文" };
    }
  }, [rawInput]);

  const protocolCenterQuery = protocolCenterSearch.trim().toLowerCase();
  const visibleProtocols = parsers.filter((parser) => {
    const meta = protocolCenterMeta[parser.id];
    const searchable = [
      parser.name,
      parser.id,
      parser.id.startsWith("wotman")
        ? "沃特曼"
        : parser.id.startsWith("joymeter") || parser.id === "cjt188-small"
          ? "Joymeter"
          : "",
      meta?.vendor,
      meta?.product,
      ...(parserCapabilities[parser.id] ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return !protocolCenterQuery || searchable.includes(protocolCenterQuery);
  });
  const activeProtocol =
    visibleProtocols.find((parser) => parser.id === selectedProtocolId) ??
    visibleProtocols[0] ??
    null;
  const visibleSamples = sampleList.filter((sample) => {
    const meta = protocolCenterMeta[sample.protocolId];
    const searchable = [
      sample.name,
      sample.description,
      sample.protocolId,
      sample.protocolId.startsWith("wotman")
        ? "沃特曼"
        : sample.protocolId.startsWith("joymeter") || sample.protocolId === "cjt188-small"
          ? "Joymeter"
          : "",
      meta?.vendor,
      meta?.product,
    ]
      .join(" ")
      .toLowerCase();
    return !protocolCenterQuery || searchable.includes(protocolCenterQuery);
  });
  const activeSample =
    visibleSamples.find((sample) => sample.id === selectedSampleId) ?? visibleSamples[0] ?? null;

  /** 解析结果变化时同步生成本地规则结论，不上传设备报文。 */
  const analysis = useMemo(() => (result ? buildAnalysisSummary(result) : null), [result]);
  const waterReadout =
    !!result && ["cjt188-small", "joymeter-mbus", "wotman-big"].includes(result.protocolId);
  const readingTime = waterReadout
    ? (result?.metrics.collectTime ?? result?.metrics.meterTime)
    : null;
  const deviceStatus = waterReadout ? result?.metrics.statusInfo : null;
  const deviceAttention =
    typeof deviceStatus === "string" && /异常|故障|欠压|报警|漏水|拆卸|逆流/.test(deviceStatus);

  /** 写参数指令随输入实时生成；错误只显示在组帧页，不影响协议解析工作台。 */
  const commandPreview = useMemo(() => {
    try {
      return { result: buildWotmanIpCommand(commandInput), error: "" };
    } catch (caught) {
      return { result: null, error: caught instanceof Error ? caught.message : "指令参数不正确。" };
    }
  }, [commandInput]);

  const syncCommandPreview = useMemo(() => {
    try {
      return { result: buildWotmanSyncCommand(syncCommandInput), error: "" };
    } catch (caught) {
      return {
        result: null,
        error: caught instanceof Error ? caught.message : "机电同步参数不正确。",
      };
    }
  }, [syncCommandInput]);

  const valveCommandPreview = useMemo(() => {
    try {
      return { result: buildValveCommand(valveCommandInput), error: "" };
    } catch (caught) {
      return {
        result: null,
        error: caught instanceof Error ? caught.message : "阀门控制参数不正确。",
      };
    }
  }, [valveCommandInput]);

  const scheduleCommandPreview = useMemo(() => {
    try {
      const schedule = uploadSchedule.map(
        ([first, second]) =>
          [
            first.trim() === "" ? null : Number(first),
            second.trim() === "" ? null : Number(second),
          ] as [number | null, number | null],
      );
      return {
        result: buildUploadScheduleCommand({ meterAddress: scheduleMeterAddress, schedule }),
        error: "",
      };
    } catch (caught) {
      return {
        result: null,
        error: caught instanceof Error ? caught.message : "自动上传时间参数不正确。",
      };
    }
  }, [scheduleMeterAddress, uploadSchedule]);

  const intervalCommandPreview = useMemo(() => {
    try {
      return { result: buildCollectionIntervalCommand(intervalCommandInput), error: "" };
    } catch (caught) {
      return {
        result: null,
        error: caught instanceof Error ? caught.message : "采集间隔参数不正确。",
      };
    }
  }, [intervalCommandInput]);

  const joymeterCommandPreview = useMemo(() => {
    try {
      return {
        result: buildJoymeterCommand({ kind: joymeterCommandType, ...joymeterInput }),
        error: "",
      };
    } catch (caught) {
      return {
        result: null,
        error: caught instanceof Error ? caught.message : "小口径水表 · 4G 指令参数不正确。",
      };
    }
  }, [joymeterCommandType, joymeterInput]);

  const activeCommandPreview =
    commandVendor === "joymeter"
      ? joymeterCommandPreview
      : commandType === "network"
        ? commandPreview
        : commandType === "sync"
          ? syncCommandPreview
          : commandType === "valve"
            ? valveCommandPreview
            : commandType === "schedule"
              ? scheduleCommandPreview
              : intervalCommandPreview;
  const joymeterPresentation =
    joymeterCommandType === "network"
      ? {
          formTitle: "填写服务器参数",
          primaryLabel: "小口径水表 · 4G 服务器",
          primaryValue: `${joymeterInput.ip}:${joymeterInput.port}`,
          secondaryLabel: "通信协议",
          secondaryValue: "UDP · 01H",
          outputHint: "A184H 数据域共 10 Bytes，可直接复制下发",
          copyLabel: "小口径水表 · 4G 写服务器指令",
          fieldHint: "IP 按网络顺序，端口按小端顺序",
        }
      : joymeterCommandType === "base"
        ? {
            formTitle: "填写基表读数",
            primaryLabel: "写入目标",
            primaryValue: joymeterInput.meterAddress.padStart(14, "0"),
            secondaryLabel: "基表读数",
            secondaryValue: `${joymeterInput.baseReading || "—"} L`,
            outputHint: "A171H 数据域共 8 Bytes，可直接复制下发",
            copyLabel: "小口径水表 · 4G 写基表读数指令",
            fieldHint: "读数使用 4 字节 BCD、小端，末尾固定 00H",
          }
        : joymeterCommandType === "valve"
          ? {
              formTitle: "填写阀门参数",
              primaryLabel: "控制目标",
              primaryValue: joymeterInput.meterAddress.padStart(14, "0"),
              secondaryLabel: "阀门操作",
              secondaryValue: joymeterInput.valveAction === "open" ? "开阀 · 55H" : "关阀 · 99H",
              outputHint: "A017H 数据域共 4 Bytes，可直接复制下发",
              copyLabel: "小口径水表 · 4G 开关阀指令",
              fieldHint: "55H 表示开阀，99H 表示关阀",
            }
          : joymeterCommandType === "reporting"
            ? {
                formTitle: "填写上报参数",
                primaryLabel: "写入目标",
                primaryValue: joymeterInput.meterAddress.padStart(14, "0"),
                secondaryLabel: "上报方案",
                secondaryValue: `${joymeterInput.startHour || "—"} 点 / ${joymeterInput.maxRandomSeconds || "—"} 秒 / ${joymeterInput.reportPeriodHours || "—"} 小时`,
                outputHint: "A180H 一次写入起始时间、随机间隔与周期",
                copyLabel: "小口径水表 · 4G 写上报参数集合指令",
                fieldHint: "起始小时为 BCD；随机间隔为 2 字节小端",
              }
            : joymeterCommandType === "start"
              ? {
                  formTitle: "设置上报起始时间",
                  primaryLabel: "写入目标",
                  primaryValue: joymeterInput.meterAddress.padStart(14, "0"),
                  secondaryLabel: "起始时间",
                  secondaryValue: `${joymeterInput.startHour || "—"} 点`,
                  outputHint: "A181H 数据域共 4 Bytes",
                  copyLabel: "小口径水表 · 4G 写上报起始时间指令",
                  fieldHint: "0–23 点，按 1 字节 BCD 编码",
                }
              : joymeterCommandType === "random"
                ? {
                    formTitle: "设置最大随机间隔",
                    primaryLabel: "写入目标",
                    primaryValue: joymeterInput.meterAddress.padStart(14, "0"),
                    secondaryLabel: "最大随机间隔",
                    secondaryValue: `${joymeterInput.maxRandomSeconds || "—"} 秒`,
                    outputHint: "A182H 数据域共 5 Bytes",
                    copyLabel: "小口径水表 · 4G 写最大随机间隔指令",
                    fieldHint: "2 字节无符号整数、小端；不得小于 10 秒",
                  }
                : {
                    formTitle: "设置上报周期",
                    primaryLabel: "写入目标",
                    primaryValue: joymeterInput.meterAddress.padStart(14, "0"),
                    secondaryLabel: "上报周期",
                    secondaryValue: `${joymeterInput.reportPeriodHours || "—"} 小时`,
                    outputHint: "A183H 数据域共 4 Bytes",
                    copyLabel: "小口径水表 · 4G 写上报周期指令",
                    fieldHint: "1 字节无符号整数，单位小时",
                  };
  const activeCommandPresentation =
    commandVendor === "joymeter"
      ? joymeterPresentation
      : commandType === "network"
        ? {
            formTitle: "填写通信参数",
            primaryLabel: "主用服务器",
            primaryValue: `${commandInput.primaryIp}:${commandInput.primaryPort}`,
            secondaryLabel: "数据区 / 整帧",
            secondaryValue: `59 / ${activeCommandPreview.result?.bytes.length ?? 0} Bytes`,
            outputHint: "DI 至 MAC 末字节共 59 Bytes，可直接复制下发",
            copyLabel: "大口径水表 · 4G写参数指令",
            fieldHint: "IP 按网络顺序，端口按小端顺序",
          }
        : commandType === "sync"
          ? {
              formTitle: "填写同步参数",
              primaryLabel: "同步目标",
              primaryValue: syncCommandInput.meterAddress.padStart(14, "0"),
              secondaryLabel: "累计流量",
              secondaryValue: `${syncCommandInput.cumulativeFlow || "—"} m³`,
              outputHint: "DI 至单位字节共 8 Bytes，可直接复制下发",
              copyLabel: "大口径水表 · 4G写机电同步指令",
              fieldHint: "累计量为 4 字节 BCD、小端，2CH 表示 0.01 m³/计数",
            }
          : commandType === "valve"
            ? {
                formTitle: "填写阀门参数",
                primaryLabel: "控制目标",
                primaryValue: valveCommandInput.meterAddress.padStart(14, "0"),
                secondaryLabel: "阀门操作",
                secondaryValue: valveCommandInput.action === "open" ? "开阀 · 55H" : "关阀 · 99H",
                outputHint: "A017H 数据区共 4 Bytes，可直接复制下发",
                copyLabel: "大口径水表 · 4G阀门控制指令",
                fieldHint: "55H 表示开阀，99H 表示关阀",
              }
            : commandType === "schedule"
              ? {
                  formTitle: "设置上传时间",
                  primaryLabel: "设置目标",
                  primaryValue: scheduleMeterAddress.padStart(14, "0"),
                  secondaryLabel: "启用时刻",
                  secondaryValue: `${scheduleCommandPreview.result?.enabledCount ?? 0} 个`,
                  outputHint: "8104H 数据区共 51 Bytes，包含 24×2 个分钟值",
                  copyLabel: "大口径水表 · 4G自动上传时间指令",
                  fieldHint: "每小时两个 1 字节分钟值，留空编码为 FFH",
                }
              : {
                  formTitle: "设置采集间隔",
                  primaryLabel: "设置目标",
                  primaryValue: intervalCommandInput.meterAddress.padStart(14, "0"),
                  secondaryLabel: "采集间隔",
                  secondaryValue: `${intervalCommandInput.intervalMinutes || "—"} 分钟`,
                  outputHint: "8105H 数据区共 4 Bytes，可直接复制下发",
                  copyLabel: "大口径水表 · 4G采集间隔指令",
                  fieldHint: "间隔时间使用 1 字节无符号整数",
                };

  const activeMeterAddress =
    commandVendor === "joymeter"
      ? joymeterInput.meterAddress
      : commandType === "network"
        ? commandInput.meterAddress
        : commandType === "sync"
          ? syncCommandInput.meterAddress
          : commandType === "valve"
            ? valveCommandInput.meterAddress
            : commandType === "schedule"
              ? scheduleMeterAddress
              : intervalCommandInput.meterAddress;

  const currentCommandId = commandVendor === "joymeter" ? joymeterCommandType : commandType;
  const directoryGroups: DirectoryGroup[] = [
    ...commandProtocols.map((protocol) => ({
      id: protocol.id,
      label: protocol.manufacturer,
      items: commandCatalog[protocol.id].flatMap((group) =>
        group.items.map((item) => ({
          id: `${protocol.id}:${item.id}`,
          label: item.label,
          code: item.di,
          keywords: item.keywords,
        })),
      ),
    })),
    {
      id: "electric",
      label: "电表 · DL/T 645",
      items: [{ id: "electric", label: "电表抄读指令", code: "645" }],
    },
    {
      id: "tools",
      label: "通用工具",
      items: [
        { id: "build", label: "Modbus组帧", code: "RTU" },
        { id: "checksum", label: "校验和计算", code: "CRC / CS" },
      ],
    },
  ];
  const selectedCommandKey =
    commandWorkspace === "device" ? `${commandVendor}:${currentCommandId}` : commandWorkspace;
  const selectDirectoryCommand = (key: string) => {
    if (key.includes(":")) {
      const [vendor, id] = key.split(":");
      setCommandVendor(vendor as CommandVendor);
      setCommandWorkspace("device");
      if (vendor === "joymeter") setJoymeterCommandType(id as JoymeterCommandKind);
      else setCommandType(id as CommandType);
    } else setCommandWorkspace(key);
    setSelectedField(null);
  };

  const batchMeterState = useMemo(() => {
    const tokens = batchMeterInput
      .split(/[\s,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const unique: Array<{ value: string; valid: boolean }> = [];
    let duplicateCount = 0;
    for (const item of tokens) {
      const valid = /^\d{1,14}$/.test(item);
      const value = valid ? item.padStart(14, "0") : item;
      const key = `${valid ? "valid" : "invalid"}:${value}`;
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
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

  const batchCommandRows = useMemo(
    () =>
      batchMeterState.valid.map((meterAddress) => {
        try {
          const result =
            commandVendor === "joymeter"
              ? buildJoymeterCommand({ kind: joymeterCommandType, ...joymeterInput, meterAddress })
              : commandType === "network"
                ? buildWotmanIpCommand({ ...commandInput, meterAddress })
                : commandType === "sync"
                  ? buildWotmanSyncCommand({ ...syncCommandInput, meterAddress })
                  : commandType === "valve"
                    ? buildValveCommand({ ...valveCommandInput, meterAddress })
                    : commandType === "schedule"
                      ? buildUploadScheduleCommand({
                          meterAddress,
                          schedule: uploadSchedule.map(
                            ([first, second]) =>
                              [
                                first.trim() === "" ? null : Number(first),
                                second.trim() === "" ? null : Number(second),
                              ] as [number | null, number | null],
                          ),
                        })
                      : buildCollectionIntervalCommand({ ...intervalCommandInput, meterAddress });
          return { meterAddress: meterAddress.padStart(14, "0"), result, error: "" };
        } catch (caught) {
          return {
            meterAddress: meterAddress.padStart(14, "0"),
            result: null,
            error: caught instanceof Error ? caught.message : "组帧失败",
          };
        }
      }),
    [
      batchMeterState.valid,
      commandInput,
      commandType,
      commandVendor,
      intervalCommandInput,
      joymeterCommandType,
      joymeterInput,
      syncCommandInput,
      uploadSchedule,
      valveCommandInput,
    ],
  );

  const joymeterMetadata: Record<
    JoymeterCommandKind,
    { label: string; di: string; summary: string }
  > = {
    network: {
      label: "写服务器 IP / 端口",
      di: "A184H",
      summary: `${joymeterInput.ip}:${joymeterInput.port} · UDP`,
    },
    base: { label: "写基表读数", di: "A171H", summary: `${joymeterInput.baseReading || "—"} L` },
    valve: {
      label: "开关阀",
      di: "A017H",
      summary: joymeterInput.valveAction === "open" ? "开阀 · 55H" : "关阀 · 99H",
    },
    reporting: {
      label: "写上报参数集合",
      di: "A180H",
      summary: `${joymeterInput.startHour} 点 · ${joymeterInput.maxRandomSeconds} 秒 · ${joymeterInput.reportPeriodHours} 小时`,
    },
    start: {
      label: "写上报起始时间",
      di: "A181H",
      summary: `${joymeterInput.startHour || "—"} 点`,
    },
    random: {
      label: "写最大随机间隔",
      di: "A182H",
      summary: `${joymeterInput.maxRandomSeconds || "—"} 秒`,
    },
    period: {
      label: "写上报周期",
      di: "A183H",
      summary: `${joymeterInput.reportPeriodHours || "—"} 小时`,
    },
  };
  const commandMetadata =
    commandVendor === "joymeter"
      ? joymeterMetadata[joymeterCommandType]
      : commandType === "network"
        ? {
            label: "写 IP / 端口",
            di: "8110H",
            summary: `${commandInput.primaryIp}:${commandInput.primaryPort} · APN ${commandInput.apn}`,
          }
        : commandType === "sync"
          ? {
              label: "写机电同步",
              di: "A016H",
              summary: `累计流量 ${syncCommandInput.cumulativeFlow || "—"} m³`,
            }
          : commandType === "valve"
            ? {
                label: "阀门控制",
                di: "A017H",
                summary: valveCommandInput.action === "open" ? "开阀 · 55H" : "关阀 · 99H",
              }
            : commandType === "schedule"
              ? {
                  label: "上传时间",
                  di: "8104H",
                  summary: `${scheduleCommandPreview.result?.enabledCount ?? 0} 个上传时刻`,
                }
              : {
                  label: "采集间隔",
                  di: "8105H",
                  summary: `${intervalCommandInput.intervalMinutes || "—"} 分钟`,
                };
  const batchBuildErrors = batchCommandRows.filter((row) => !row.result);
  const batchReady =
    batchCommandRows.length > 0 &&
    batchMeterState.invalid.length === 0 &&
    batchMeterState.overflowCount === 0 &&
    batchBuildErrors.length === 0;

  const exportBatchCommands = () => {
    if (!batchReady) return;
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    downloadXlsx({
      filename: `${commandVendor === "joymeter" ? "小口径水表 · 4G" : "大口径水表 · 4G"}批量指令_${commandMetadata.di.replace("H", "")}_${stamp}.xlsx`,
      sheetName: "批量指令",
      columns: [
        { title: "序号", width: 8 },
        { title: "表号", width: 20 },
        { title: "指令类型", width: 18 },
        { title: "数据标识 DI", width: 15 },
        { title: "参数摘要", width: 34, wrap: true },
        { title: "完整 HEX 指令", width: 95, wrap: true },
        { title: "字节数", width: 12 },
        { title: "校验码 CS", width: 14 },
      ],
      rows: batchCommandRows.map((row, index) => [
        String(index + 1),
        row.meterAddress,
        commandMetadata.label,
        commandMetadata.di,
        commandMetadata.summary,
        row.result!.compactHex,
        String(row.result!.bytes.length),
        row.result!.checksum,
      ]),
    });
    setActionFeedback("export-command");
    setToast(`已导出 ${batchCommandRows.length} 条批量指令`);
  };

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try {
      window.localStorage.setItem("eoiot-theme", next);
    } catch {
      setToast("主题已切换，但浏览器不允许保存，下次打开将使用默认主题。");
    }
  };

  /** 成功解析后写入有限的本机历史，重复报文仍保留不同调试时刻。 */
  const remember = (parsed: ParseResult, normalized: string) => {
    addRecord(createParseRecord(parsed, normalized));
  };

  const parseFrame = () => {
    setModbusFrame(null);
    setModbusDirty(false);
    setModbusConfigError("");
    try {
      const bytes = parseHex(rawInput);
      const parser = validateWithRegistry(bytes);
      const normalized = hex(bytes);
      if (parser.id === "modbus-rtu" && (bytes[1] & 0x80) === 0) {
        const request = bytes.length === 8;
        setRawInput(normalized);
        setModbusFrame(request ? null : bytes);
        setModbusDirty(!request);
        setResult(request ? parser.parse(bytes) : null);
        setSelectedField(null);
        setError("");
        setMessage(
          request ? "读取请求 · CRC 校验通过 · 等待设备应答" : "已识别 Modbus RTU，设置参数后应用",
        );
        if (request) remember(parser.parse(bytes), normalized);
        return;
      }
      const parsed = parser.parse(bytes);
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

  const applyModbusParameters = () => {
    if (!modbusFrame) return;
    try {
      const parsed = parseWithRegistry(
        modbusFrame,
        "modbus-rtu",
        modbusOptions.modbusDecode
          ? {
              modbusDecode: {
                ...modbusOptions.modbusDecode,
                registerAddress: undefined,
                model: undefined,
              },
            }
          : {},
      );
      setResult(parsed);
      setModbusDirty(false);
      setModbusConfigError("");
      setSelectedField(null);
      setActiveTab("overview");
      setMessage(
        modbusFrame.length === 8
          ? "读取规则已设置 · 等待设备应答数据"
          : "Modbus 参数已应用 · CRC 校验通过",
      );
      remember(parsed, hex(modbusFrame));
    } catch (caught) {
      setModbusConfigError(caught instanceof Error ? caught.message : "请检查解析参数。");
      setMessage("参数未应用，请检查设置");
    }
  };

  /** 从样例页载入时立即解析，让用户一步回到完整结果态。 */
  const useSample = (sample: (typeof sampleList)[number]) => {
    invalidateInput();
    setRawInput(formatHexIfValid(sample.value));
    setView("studio");
    setSelectedField(null);
    try {
      const sampleOptions: ParseOptions =
        "modbusDecode" in sample ? { modbusDecode: sample.modbusDecode } : modbusOptions;
      if (sampleOptions.modbusDecode && sample.protocolId === "modbus-rtu") {
        setModbusMode("custom");
        setModbusForm(modbusConfigToForm(sampleOptions.modbusDecode));
      }
      const bytes = parseHex(sample.value);
      const parser = validateWithRegistry(bytes);
      if (parser.id === "modbus-rtu" && (bytes[1] & 0x80) === 0) {
        if (bytes.length === 8)
          setModbusForm((current) => ({
            ...current,
            registerAddress: String(bytes[2] * 256 + bytes[3]),
          }));
        setModbusFrame(bytes);
        setModbusDirty(true);
        setResult(bytes.length === 8 ? parser.parse(bytes) : null);
        setMessage("已载入 Modbus 样例，设置参数后应用");
        return;
      }
      const parsed = parser.parse(bytes, sampleOptions);
      setResult(parsed);
      setActiveTab("overview");
      setError("");
      setMessage(`已载入 ${sample.name}`);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "请检查解析参数。");
      setMessage("样例已载入，请检查解析参数后重新解析");
    }
  };

  const formatInput = () => {
    try {
      setRawInput(hex(parseHex(rawInput)));
      setError("");
      setActionFeedback("format");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法格式化当前内容。");
    }
  };

  const copyText = async (text: string, label: string, feedback?: ActionFeedback) => {
    try {
      await navigator.clipboard.writeText(text);
      if (feedback) setActionFeedback(feedback);
      else setToast(`${label}已复制`);
    } catch {
      setError("浏览器未授予剪贴板权限，请手动复制。");
    }
  };

  const pasteFrame = async () => {
    try {
      setRawInput(formatHexIfValid(await navigator.clipboard.readText()));
      invalidateInput();
      setResult(null);
      setSelectedField(null);
      setMessage("已粘贴新报文，等待解析");
      setError("");
      setActionFeedback("paste");
    } catch {
      setError("浏览器未授予剪贴板读取权限，请使用 Ctrl+V。");
    }
  };

  /** 清空编辑器及旧结果，并在按钮本身显示明确反馈。 */
  const clearFrame = () => {
    invalidateInput();
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
    reader.onload = () => {
      invalidateInput();
      setRawInput(formatHexIfValid(String(reader.result ?? "")));
      setView("studio");
      setToast(`已导入 ${file.name}`);
    };
    reader.onerror = () => setError("文件读取失败，请确认它是文本格式。");
    reader.readAsText(file);
    event.target.value = "";
  };

  const exportJson = () => {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `eoiot-${result.dataIdentifier || "result"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setActionFeedback("export-json");
  };

  const reuseRecord = (record: ParseRecord) => {
    invalidateInput();
    setRawInput(record.raw);
    setView("studio");
    setSelectedField(null);
    setActiveTab("overview");
    try {
      const bytes = parseHex(record.raw);
      const restoredOptions: ParseOptions = record.modbusDecode
        ? { modbusDecode: record.modbusDecode }
        : record.modbusRaw
          ? {}
          : record.modbusProfile
            ? { modbusProfile: record.modbusProfile }
            : modbusOptions;
      const parsed = parseWithRegistry(bytes, "auto", restoredOptions);
      if (parsed.protocolId === "modbus-rtu") {
        if ((bytes[1] & 0x80) === 0 && bytes.length !== 8) setModbusFrame(bytes);
        if (typeof parsed.metrics.decodeConfig === "string") {
          setModbusMode("custom");
          setModbusForm(
            modbusConfigToForm(JSON.parse(parsed.metrics.decodeConfig) as ModbusDecodeConfig),
          );
        } else setModbusMode("raw");
      }
      setRawInput(hex(bytes));
      setResult(parsed);
      setError("");
      setMessage(`${parsed.protocol} · 历史报文重新解析成功`);
      remember(parsed, hex(bytes));
    } catch (caught) {
      setResult(null);
      setMessage("历史报文解析失败");
      setError(caught instanceof Error ? caught.message : "解析失败，请检查报文。");
    }
  };
  const clearRecords = () => {
    if (
      !window.confirm(
        `确定清空全部 ${records.length} 条已载入记录及本机存储中的原始记录（包含可能未能载入的记录）？清空后无法恢复。`,
      )
    )
      return;
    if (!clearStoredRecords()) return;
    setExpandedRecordId(null);
    setRecordProtocol("");
    setRecordSearch("");
    setToast("本机记录已清空");
  };
  const deleteRecord = (id: string) => {
    removeRecord(id);
    if (expandedRecordId === id) setExpandedRecordId(null);
    setToast("记录已删除");
  };
  const recordProtocols = [...new Set(records.map((record) => record.protocol))];
  const visibleRecords = records
    .filter((record) => {
      const query = recordSearch.trim().toLowerCase();
      return (
        (!recordProtocol || record.protocol === recordProtocol) &&
        (!query ||
          `${record.meterNo} ${record.protocol} ${record.coreValue}`.toLowerCase().includes(query))
      );
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const renderMeterAddressField = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    note: string,
  ) =>
    commandGenerationMode === "batch" ? (
      <label className="batch-meter-field">
        <span>批量表号</span>
        <textarea
          value={batchMeterInput}
          onChange={(event) => setBatchMeterInput(event.target.value)}
          placeholder={"每行一个表号，也支持空格、逗号分隔\n例如：\n00430500003931\n00430500003932"}
        />
        <small>最多 500 个，重复表号会自动去除；导出的 Excel 会把表号保存为文本。</small>
        <div className="batch-meter-stats">
          <strong>{batchMeterState.valid.length} 个有效</strong>
          {batchMeterState.invalid.length > 0 && (
            <span className="invalid">{batchMeterState.invalid.length} 个格式错误</span>
          )}
          {batchMeterState.duplicateCount > 0 && (
            <span>{batchMeterState.duplicateCount} 个重复已忽略</span>
          )}
          {batchMeterState.overflowCount > 0 && (
            <span className="invalid">超出上限 {batchMeterState.overflowCount} 个</span>
          )}
        </div>
        {batchMeterState.invalid.length > 0 && (
          <code className="batch-invalid-list">
            错误：{batchMeterState.invalid.slice(0, 5).join("、")}
            {batchMeterState.invalid.length > 5 ? "…" : ""}
          </code>
        )}
      </label>
    ) : (
      <label>
        <span>{label}</span>
        <input
          value={value}
          inputMode="numeric"
          maxLength={14}
          onChange={(event) => onChange(event.target.value)}
        />
        <small>{note}</small>
      </label>
    );

  return (
    <main
      className="studio-app"
      data-theme={theme}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          parseFrame();
        }
      }}
    >
      <header className="topbar">
        <button
          className="brand brand-button"
          type="button"
          onClick={() => setView("studio")}
          aria-label="返回协议解析工作台"
        >
          <BrandMark />
          <span>
            <strong>EOIOT</strong>
            <small>Protocol Studio</small>
          </span>
        </button>
        <div className="workspace-switch">
          <strong>源一物联</strong>
          <span>/ 协议研发空间</span>
        </div>
        <span className="version-pill">V2 Preview</span>
        <button
          className="theme-toggle"
          type="button"
          onClick={toggleTheme}
          aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
        >
          <span>{theme === "light" ? "◐" : "☀"}</span>
          {theme === "light" ? "切换深色" : "切换浅色"}
        </button>
      </header>

      <div className="app-grid">
        <aside className="sidebar">
          <nav aria-label="主导航">
            <p className="nav-title">工作台</p>
            <button
              className={`nav-item${view === "studio" ? " active" : ""}`}
              type="button"
              onClick={() => setView("studio")}
            >
              <NavIcon name="parser" />
              <b>协议解析</b>
            </button>
            <button
              className={`nav-item${view === "commands" ? " active" : ""}`}
              type="button"
              onClick={() => setView("commands")}
            >
              <NavIcon name="command" />
              <b>指令生成</b>
            </button>
            <button
              className={`nav-item${view === "library" || view === "samples" ? " active" : ""}`}
              type="button"
              onClick={() => setView("library")}
            >
              <NavIcon name="library" />
              <b>协议中心</b>
            </button>
            <button
              className={`nav-item${view === "records" ? " active" : ""}`}
              type="button"
              onClick={() => setView("records")}
            >
              <NavIcon name="history" />
              <b>解析记录</b>
            </button>
            <p className="nav-title">云端能力</p>
            <button className="nav-item is-disabled" type="button" disabled>
              <NavIcon name="device" />
              <b>设备与上报</b>
              <em>规划中</em>
            </button>
            <button className="nav-item is-disabled" type="button" disabled>
              <NavIcon name="team" />
              <b>团队协作</b>
              <em>规划中</em>
            </button>
          </nav>
          <div className="local-note">
            <span className="secure-dot" />
            <strong>隐私安全</strong>
            <p>解析与记录仅保存在本机</p>
          </div>
        </aside>

        {view === "studio" && (
          <section className="page studio-page">
            <div className="page-heading">
              <div>
                <h1>协议解析工作台</h1>
                <span>粘贴设备报文，快速查看字段、字节与诊断结果。</span>
              </div>
              <div className="heading-actions">
                <button type="button" onClick={() => fileInputRef.current?.click()}>
                  导入文本
                </button>
                <button type="button" onClick={() => setView("samples")}>
                  打开样例库
                </button>
              </div>
            </div>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept=".txt,.log,.hex,text/plain"
              onChange={importText}
            />

            <div className={`workbench${!result && !modbusFrame ? " is-empty" : ""}`}>
              <section className="panel input-panel">
                <div className="panel-title">
                  <div>
                    <span className="step">01</span>
                    <strong>输入原始帧</strong>
                  </div>
                  <span className="byte-count">{inputState.count} Bytes</span>
                </div>
                <div className="input-body">
                  <div className="auto-recognition">
                    <ToolIcon name="format" />
                    <div>
                      <strong>协议与端序自动识别</strong>
                      <p>
                        支持小口径水表（4G / MBus）、大口径水表（4G）、DL/T 645 电表及 Modbus RTU。
                      </p>
                    </div>
                  </div>
                  <div className={`hex-editor${error ? " has-error" : ""}`}>
                    <div className="editor-toolbar">
                      <span className="editor-label">
                        <ToolIcon name="code" />
                        HEX / RAW FRAME
                      </span>
                      <div className="tool-actions">
                        <CopyButton
                          ariaLabel="复制原始报文"
                          disabled={!rawInput.trim()}
                          copied={actionFeedback === "copy-input"}
                          onCopy={() => void copyText(rawInput, "原始报文", "copy-input")}
                        />
                        <button
                          className={actionFeedback === "paste" ? "is-success" : ""}
                          type="button"
                          onClick={pasteFrame}
                        >
                          {actionFeedback === "paste" ? (
                            <ToolIcon name="check" />
                          ) : (
                            <ToolIcon name="paste" />
                          )}
                          <span>{actionFeedback === "paste" ? "已粘贴" : "粘贴"}</span>
                        </button>
                        <button
                          className={actionFeedback === "format" ? "is-success" : ""}
                          type="button"
                          onClick={formatInput}
                        >
                          {actionFeedback === "format" ? (
                            <ToolIcon name="check" />
                          ) : (
                            <ToolIcon name="format" />
                          )}
                          <span>{actionFeedback === "format" ? "已格式化" : "格式化"}</span>
                        </button>
                        <button
                          className={actionFeedback === "clear" ? "is-success" : ""}
                          type="button"
                          onClick={clearFrame}
                        >
                          {actionFeedback === "clear" ? (
                            <ToolIcon name="check" />
                          ) : (
                            <ToolIcon name="clear" />
                          )}
                          <span>{actionFeedback === "clear" ? "已清空" : "清空"}</span>
                        </button>
                      </div>
                    </div>
                    <div className="editor-main">
                      <textarea
                        value={rawInput}
                        onPaste={(event) => {
                          const input = event.currentTarget;
                          const text = event.clipboardData.getData("text/plain");
                          event.preventDefault();
                          setRawInput(
                            formatHexIfValid(
                              rawInput.slice(0, input.selectionStart) +
                                text +
                                rawInput.slice(input.selectionEnd),
                            ),
                          );
                          invalidateInput();
                        }}
                        onChange={(event) => {
                          setRawInput(event.target.value);
                          invalidateInput();
                        }}
                        wrap="soft"
                        spellCheck={false}
                        aria-label="原始十六进制报文"
                        placeholder="粘贴 HEX 报文，支持空格、换行、逗号和 0x 前缀"
                      />
                    </div>
                    <div className="editor-status">
                      <span>{inputState.text}</span>
                      <span>本地处理 · 不上传</span>
                    </div>
                  </div>
                  <div className="input-actions">
                    <button
                      className="parse-button"
                      type="button"
                      disabled={!rawInput.trim()}
                      onClick={parseFrame}
                    >
                      解析报文
                    </button>
                    <button
                      className="sample-button"
                      type="button"
                      onClick={() =>
                        useSample(
                          sampleList[
                            (sampleList.findIndex(
                              (item) => formatHexIfValid(item.value) === formatHexIfValid(rawInput),
                            ) +
                              1) %
                              sampleList.length
                          ],
                        )
                      }
                    >
                      换个样例
                    </button>
                  </div>
                  {error ? (
                    <p className="inline-error" role="alert">
                      {error}
                    </p>
                  ) : (
                    <p className="input-footnote">
                      每次成功解析会保存到本机记录，最多保留 20 条，可随时清空。
                    </p>
                  )}
                  {recordStorageNotice && (
                    <p className="record-storage-notice" role="status">
                      {recordStorageNotice}
                    </p>
                  )}
                </div>
              </section>

              <section className="panel result-panel">
                <div className="panel-title">
                  <div>
                    <span className="step">02</span>
                    <strong>解析结果</strong>
                  </div>
                  <span
                    className="result-state"
                    data-state={
                      error ? "error" : modbusDirty ? "pending" : result ? "ready" : "waiting"
                    }
                  >
                    <i /> {message}
                  </span>
                </div>
                {modbusFrame && (
                  <section className="modbus-config" aria-label="Modbus 自定义解析参数">
                    <header>
                      <strong>Modbus RTU · 解析设置</strong>
                      <span className="modbus-envelope-ok">CRC 校验通过</span>
                      <div className="modbus-mode-switch" aria-label="解析模式">
                        {(["custom", "raw"] as const).map((mode) => (
                          <button
                            type="button"
                            key={mode}
                            aria-pressed={modbusMode === mode}
                            className={modbusMode === mode ? "active" : ""}
                            onClick={() => {
                              setModbusMode(mode);
                              resetModbusResult();
                            }}
                          >
                            {mode === "custom" ? "数值解析" : "原始寄存器"}
                          </button>
                        ))}
                      </div>
                    </header>
                    <fieldset disabled={modbusMode === "raw"}>
                      <legend className="visually-hidden">数据解释规则</legend>
                      <div className="modbus-config-grid modbus-device-fields">
                        <label>
                          <span>数据名称（可选）</span>
                          <input
                            value={modbusForm.label}
                            maxLength={40}
                            placeholder="例如 温度、压力、转速"
                            onChange={(event) => updateModbusForm({ label: event.target.value })}
                          />
                        </label>
                        <label>
                          <span>显示小数位</span>
                          <ThemedSelect
                            label="显示小数位"
                            value={modbusForm.decimals}
                            disabled={modbusMode === "raw"}
                            options={[
                              { value: "auto", label: "自动" },
                              ...Array.from({ length: 9 }, (_, index) => ({
                                value: String(index),
                                label: index + " 位",
                              })),
                            ]}
                            onChange={(value) => updateModbusForm({ decimals: value })}
                          />
                        </label>
                      </div>
                      <div className="modbus-config-grid">
                        <label>
                          <span>数据类型</span>
                          <ThemedSelect
                            label="数据类型"
                            value={modbusForm.dataType}
                            disabled={modbusMode === "raw"}
                            options={["UINT16", "INT16", "UINT32", "INT32", "FLOAT32"].map(
                              (type) => ({
                                value: type,
                                label:
                                  type + (type.endsWith("16") ? " · 1 个寄存器" : " · 2 个寄存器"),
                              }),
                            )}
                            onChange={(value) => {
                              const dataType = value as ModbusDataType;
                              const short = dataType.endsWith("16");
                              const byteOrder = (
                                short
                                  ? ["AB", "BA"].includes(modbusForm.byteOrder)
                                    ? modbusForm.byteOrder
                                    : "AB"
                                  : modbusForm.byteOrder.length === 4
                                    ? modbusForm.byteOrder
                                    : "ABCD"
                              ) as ModbusByteOrder;
                              updateModbusForm({ dataType, byteOrder });
                            }}
                          />
                        </label>
                        <label>
                          <span>字节序</span>
                          <ThemedSelect
                            label="字节序"
                            value={modbusForm.byteOrder}
                            disabled={modbusMode === "raw"}
                            options={(modbusForm.dataType.endsWith("16")
                              ? [
                                  ["AB", "AB · 高字节在前"],
                                  ["BA", "BA · 交换字节"],
                                ]
                              : [
                                  ["ABCD", "ABCD · 顺序"],
                                  ["CDAB", "CDAB · 交换寄存器"],
                                  ["BADC", "BADC · 寄存器内交换"],
                                  ["DCBA", "DCBA · 全部反转"],
                                ]
                            ).map(([value, label]) => ({ value, label }))}
                            onChange={(value) =>
                              updateModbusForm({ byteOrder: value as ModbusByteOrder })
                            }
                          />
                        </label>
                        <label>
                          <span>缩放因子（乘数）</span>
                          <input
                            value={modbusForm.scale}
                            inputMode="decimal"
                            placeholder="例如 1 或 0.01"
                            onChange={(event) => updateModbusForm({ scale: event.target.value })}
                          />
                        </label>
                        <label>
                          <span>单位（可留空）</span>
                          <input
                            value={modbusForm.unit}
                            maxLength={24}
                            list="modbus-units"
                            placeholder="例如 kWh、V、℃"
                            onChange={(event) => updateModbusForm({ unit: event.target.value })}
                          />
                          <datalist id="modbus-units">
                            {["kWh", "Wh", "V", "A", "W", "kW", "Hz", "m³", "℃", "%"].map(
                              (unit) => (
                                <option key={unit} value={unit} />
                              ),
                            )}
                          </datalist>
                        </label>
                      </div>
                      <div className="modbus-range-settings">
                        <label className="modbus-range-toggle">
                          <input
                            type="checkbox"
                            checked={modbusForm.rangeMode === "custom"}
                            onChange={(event) =>
                              updateModbusForm({
                                rangeMode: event.target.checked ? "custom" : "all",
                              })
                            }
                          />
                          <span>自定义解析范围</span>
                        </label>
                        {modbusForm.rangeMode === "all" ? (
                          <p>
                            {Number.isInteger(modbusAutoCount) ? (
                              <>
                                默认解析全部数据：{modbusFrame[2]} 字节 → {modbusAutoCount} 个{" "}
                                {modbusForm.dataType} 数值。
                              </>
                            ) : (
                              <>
                                当前数据区 {modbusFrame[2]} 字节，无法按每个数 {modbusBytesPerValue}{" "}
                                字节完整分组；请检查类型或启用自定义范围。
                              </>
                            )}
                          </p>
                        ) : (
                          <>
                            <div className="modbus-config-grid">
                              <label>
                                <span>起始位置（寄存器，从 0 计）</span>
                                <input
                                  type="number"
                                  min="0"
                                  max="124"
                                  step="1"
                                  value={modbusForm.registerOffset}
                                  onChange={(event) =>
                                    updateModbusForm({ registerOffset: event.target.value })
                                  }
                                />
                              </label>
                              <label>
                                <span>解析数量（组）</span>
                                <input
                                  type="number"
                                  min="1"
                                  max="125"
                                  step="1"
                                  value={modbusForm.valueCount}
                                  onChange={(event) =>
                                    updateModbusForm({ valueCount: event.target.value })
                                  }
                                />
                              </label>
                            </div>
                            <p>
                              起始位置相对于应答数据区，从 0 计；32 位数占 2
                              个寄存器。仅解析所选范围，其余寄存器保留原始展示。
                            </p>
                          </>
                        )}
                      </div>
                    </fieldset>
                    <p className="modbus-formula">
                      {modbusMode === "raw" ? (
                        "仅显示原始寄存器，不应用数据类型、缩放与单位。"
                      ) : (
                        <>
                          结果 = 解码值 × {modbusForm.scale || "缩放因子"}
                          {modbusForm.unit ? " " + modbusForm.unit : ""}。点击应用参数更新结果。
                        </>
                      )}
                    </p>
                    <footer className="modbus-config-actions">
                      <span>
                        {modbusFrame?.length === 8
                          ? modbusDirty
                            ? "读取规则待应用"
                            : "读取规则已设置，数值等待应答"
                          : modbusDirty
                            ? result
                              ? "参数已修改，以下为上次应用的结果"
                              : "参数尚未应用"
                            : "参数已应用"}
                      </span>
                      <button
                        type="button"
                        onClick={applyModbusParameters}
                        disabled={!modbusDirty && !!result}
                      >
                        {modbusDirty || !result ? "应用参数" : "已应用"}
                      </button>
                    </footer>
                    {modbusConfigError && (
                      <p className="modbus-config-error" role="alert">
                        {modbusConfigError}
                      </p>
                    )}
                  </section>
                )}
                {result ? (
                  <>
                    {result.protocolId === "modbus-rtu" && modbusDirty && (
                      <div className="modbus-outdated" role="status">
                        {modbusFrame?.length === 8
                          ? "当前为读取请求，不含测量数值。可为该地址设置解析规则，收到设备应答后再解码。"
                          : "参数尚未应用，以下为上次结果。"}
                      </div>
                    )}
                    {!(coreReadout && (waterReadout || electricResult)) && (
                      <div className="result-hero">
                        <div className="protocol-identity">
                          <span className="success-mark">✓</span>
                          <div>
                            <p>识别到协议</p>
                            <h2>{result.protocol}</h2>
                          </div>
                        </div>
                        <div className="confidence">
                          <span>匹配度</span>
                          <strong>{result.confidence}%</strong>
                        </div>
                      </div>
                    )}
                    {coreReadout && (waterReadout || electricResult) ? (
                      <ReadingFocus
                        result={result}
                        number={coreReadout[1]}
                        unit={coreReadout[2]}
                        copy={() => void copyText(result.meterNo, "表号")}
                      >
                        {electricResult && <ElectricReadings result={result} />}
                      </ReadingFocus>
                    ) : (
                      <section className="reading-summary" aria-label="核心读数与设备信息">
                        <div className="reading-summary-value">
                          <span>
                            {result.protocolId === "modbus-rtu"
                              ? coreReadout
                                ? String(result.metrics.label)
                                : "解析结果"
                              : electricResult && coreReadout
                                ? typeof result.metrics.rate === "number" && result.metrics.rate > 0
                                  ? `费率 ${result.metrics.rate} 电量`
                                  : "累计用量"
                                : coreReadout
                                  ? "当前累计量"
                                  : "报文内容"}
                          </span>
                          <strong>
                            {coreReadout ? (
                              <>
                                <span className="reading-number">{coreReadout[1]}</span>
                                <span className="reading-unit">{coreReadout[2]}</span>
                              </>
                            ) : (
                              result.coreValue
                            )}
                          </strong>
                        </div>
                        <dl className="reading-summary-meta">
                          <div className="reading-meter">
                            <dt>{result.protocolId === "modbus-rtu" ? "从站地址" : "表号"}</dt>
                            <dd>
                              <strong>{result.meterNo}</strong>
                              <button
                                type="button"
                                className="meter-copy"
                                aria-label="复制表号"
                                onClick={() => void copyText(result.meterNo, "表号")}
                              >
                                复制
                              </button>
                            </dd>
                          </div>
                          {waterReadout ? (
                            <div className="reading-time">
                              <dt>
                                {result.metrics.collectTime != null ? "上报时间" : "水表时间"}
                              </dt>
                              <dd>
                                {readingTime == null || readingTime === "—"
                                  ? "无"
                                  : String(readingTime)}
                              </dd>
                            </div>
                          ) : (
                            (result.protocolId !== "modbus-rtu" ||
                              result.metrics.purpose === "读取请求") && (
                              <div>
                                <dt>
                                  {result.protocolId === "modbus-rtu" ? "寄存器地址" : "数据标识"}
                                </dt>
                                <dd>{result.dataIdentifier}</dd>
                              </div>
                            )
                          )}
                          {!waterReadout && (
                            <div>
                              <dt>{result.protocolId === "modbus-rtu" ? "功能码" : "控制码"}</dt>
                              <dd>{result.controlCode}</dd>
                            </div>
                          )}
                        </dl>
                      </section>
                    )}
                    {deviceAttention && !(coreReadout && waterReadout) && (
                      <div className="device-priority-alert" role="status">
                        <strong>设备需要关注</strong>
                        <span>{String(deviceStatus)}</span>
                      </div>
                    )}
                    {result.diagnostics.some((item) => item.level === "bad") && (
                      <div className="device-priority-alert is-error" role="alert">
                        <strong>报文校验或解析异常</strong>
                        <span>
                          {result.diagnostics
                            .filter((item) => item.level === "bad")
                            .map((item) => item.text)
                            .join("；")}
                        </span>
                      </div>
                    )}
                    <div className="tabs" role="tablist" aria-label="解析结果视图">
                      {resultTabs.map((tab, index) => (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          aria-selected={activeTab === tab.id}
                          tabIndex={activeTab === tab.id ? 0 : -1}
                          className={activeTab === tab.id ? "active" : ""}
                          onClick={() => setActiveTab(tab.id)}
                          onKeyDown={(event) => {
                            if (
                              event.key !== "ArrowLeft" &&
                              event.key !== "ArrowRight" &&
                              event.key !== "Home" &&
                              event.key !== "End"
                            )
                              return;
                            event.preventDefault();
                            const nextIndex =
                              event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? resultTabs.length - 1
                                  : (index +
                                      (event.key === "ArrowRight" ? 1 : -1) +
                                      resultTabs.length) %
                                    resultTabs.length;
                            setActiveTab(resultTabs[nextIndex].id);
                            (
                              event.currentTarget.parentElement?.children[nextIndex] as
                                HTMLButtonElement | undefined
                            )?.focus();
                          }}
                        >
                          {tab.label}
                          {tab.id === "history" && result.history.length > 0 && (
                            <em>{result.history.length}</em>
                          )}
                          {tab.id === "diagnostics" && <em>{result.diagnostics.length}</em>}
                        </button>
                      ))}
                    </div>
                    <div className="tab-content">
                      {activeTab === "overview" &&
                        (result.protocolId === "modbus-rtu" ? (
                          <ModbusOverview result={result} />
                        ) : result.protocolId === "dlt645-energy" ? (
                          <>
                            {!coreReadout && <ElectricReadings result={result} />}
                            <ElectricReportDetails
                              result={result}
                              copied={actionFeedback === "copy-explanation"}
                              onCopy={(text) => void copyText(text, "解析说明", "copy-explanation")}
                            />
                          </>
                        ) : waterReadout && coreReadout ? (
                          <WaterOverview
                            result={result}
                            onHistory={() => setActiveTab("history")}
                          />
                        ) : (
                          <>
                            {result.protocolId === "cjt188-small" ||
                            result.protocolId === "joymeter-mbus" ? (
                              <WaterStatusPanel result={result} />
                            ) : (
                              analysis &&
                              result.protocolId !== "wotman-command" && (
                                <section
                                  className={`analysis-card analysis-${analysis.level}`}
                                  aria-label="分析结论"
                                >
                                  <header>
                                    <div>
                                      <span className="analysis-icon">
                                        {analysis.level === "normal"
                                          ? "✓"
                                          : analysis.level === "abnormal"
                                            ? "×"
                                            : "!"}
                                      </span>
                                      <strong>
                                        {waterReadout ? "设备与上报状态" : analysis.title}
                                      </strong>
                                    </div>
                                    <span className="analysis-status">{analysis.statusLabel}</span>
                                  </header>
                                  <div className="analysis-body">
                                    <div className="analysis-summary-grid">
                                      {analysis.items
                                        .filter(
                                          (item) =>
                                            !waterReadout ||
                                            (item.key !== "cumulative" && item.key !== "time"),
                                        )
                                        .map((item) => (
                                          <article
                                            className={`analysis-item analysis-item-${item.key}`}
                                            key={item.key}
                                          >
                                            <span>{item.label}</span>
                                            {waterReadout &&
                                            item.key === "signals" &&
                                            result.protocolId !== "wotman-big" &&
                                            result.protocolId !== "joymeter-mbus" ? (
                                              <details className="signal-details">
                                                <summary>查看网络与信号原始值</summary>
                                                <div className="signal-values">
                                                  {item.value.split(" · ").map((value) => (
                                                    <span key={value}>{value}</span>
                                                  ))}
                                                </div>
                                              </details>
                                            ) : (
                                              <strong
                                                className={
                                                  item.key === "signals" && deviceAttention
                                                    ? "metric-attention"
                                                    : undefined
                                                }
                                              >
                                                {item.value}
                                              </strong>
                                            )}
                                            {item.note && <small>{item.note}</small>}
                                          </article>
                                        ))}
                                    </div>
                                    <p className="analysis-advice">
                                      <strong>建议</strong>
                                      {analysis.recommendation}
                                    </p>
                                  </div>
                                </section>
                              )
                            )}
                            <details className="technical-summary">
                              <summary>
                                报文与检查信息 · {result.rawBytes.length} Bytes · DI{" "}
                                {result.dataIdentifier} · 控制码 {result.controlCode}
                              </summary>
                              <div className="result-insights">
                                <article>
                                  <span>帧长度</span>
                                  <strong>{result.rawBytes.length} Bytes</strong>
                                </article>
                                <article>
                                  <span>已识别字段</span>
                                  <strong>{result.fields.length} 项</strong>
                                </article>
                                <article>
                                  <span>诊断状态</span>
                                  <strong>
                                    {result.diagnostics.some((item) => item.level === "bad")
                                      ? "存在错误"
                                      : result.diagnostics.some((item) => item.level === "warn")
                                        ? "需要关注"
                                        : "解析检查通过"}
                                  </strong>
                                </article>
                                {result.history.length > 0 && (
                                  <article>
                                    <span>历史记录</span>
                                    <strong>{result.history.length} 条</strong>
                                  </article>
                                )}
                              </div>
                            </details>
                            <div className="overview-sections">
                              {result.overviewSections.map((section) => {
                                const visibleItems = section.items.filter(
                                  (item) =>
                                    item.value !== null &&
                                    item.value !== "—" &&
                                    !(
                                      result.protocolId === "wotman-big" &&
                                      ["rsrp", "rsrq", "snr", "ecl", "pci"].includes(item.key)
                                    ),
                                );
                                return (
                                  <section
                                    className={`overview-group overview-${section.id}`}
                                    data-count={visibleItems.length}
                                    key={section.id}
                                  >
                                    <h3>
                                      <span>{section.title}</span>
                                      <em>{visibleItems.length} 项</em>
                                    </h3>
                                    <div className="metric-grid">
                                      {visibleItems.map((item) => (
                                        <article key={item.key} data-metric={item.key}>
                                          <span>{item.label}</span>
                                          <strong>{formatMetric(item.value, item.unit)}</strong>
                                          {item.note && <small>{item.note}</small>}
                                        </article>
                                      ))}
                                    </div>
                                  </section>
                                );
                              })}
                            </div>
                          </>
                        ))}
                      {activeTab === "fields" && (
                        <FieldExplanation
                          result={result}
                          selectedField={selectedField}
                          onSelect={setSelectedField}
                        />
                      )}
                      {activeTab === "bytes" && (
                        <ByteMap
                          result={result}
                          selectedField={selectedField}
                          onSelect={setSelectedField}
                        />
                      )}
                      {activeTab === "history" &&
                        (result.history.length ? (
                          <div className="table-scroll">
                            <table>
                              <thead>
                                <tr>
                                  <th>采集时间</th>
                                  <th>正向累计</th>
                                  <th>反向累计</th>
                                  <th>瞬时流量</th>
                                  <th>压力</th>
                                </tr>
                              </thead>
                              <tbody>
                                {result.history.map((item, index) => (
                                  <tr key={`${item.collectTime}-${index}`}>
                                    <td>{item.collectTime}</td>
                                    <td>{item.forwardFlow ?? "—"}</td>
                                    <td>{item.reverseFlow ?? "—"}</td>
                                    <td>{item.instantFlow ?? "—"}</td>
                                    <td>{item.pressure ?? "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="empty-tab">
                            <span>↺</span>
                            <strong>这条报文没有历史数据</strong>
                            <p>可在样例库载入大口径水表 · 4G 9021 报文体验历史数据解析。</p>
                          </div>
                        ))}
                      {activeTab === "diagnostics" && (
                        <div className="diagnostic-list">
                          {result.diagnostics.map((item, index) => (
                            <article className={`diag-${item.level}`} key={`${item.text}-${index}`}>
                              <span>
                                {item.level === "ok" ? "✓" : item.level === "warn" ? "!" : "×"}
                              </span>
                              <div>
                                <strong>
                                  {item.level === "ok"
                                    ? "检查通过"
                                    : item.level === "warn"
                                      ? "需要关注"
                                      : "解析错误"}
                                </strong>
                                <p>{item.text}</p>
                              </div>
                            </article>
                          ))}
                        </div>
                      )}
                      {activeTab === "json" && (
                        <div className="json-view">
                          <div className="json-toolbar">
                            <span>
                              <ToolIcon name="code" />
                              结构化解析结果
                            </span>
                            <div className="tool-actions">
                              <button
                                className={actionFeedback === "copy-json" ? "is-success" : ""}
                                type="button"
                                onClick={() =>
                                  copyText(JSON.stringify(result, null, 2), "JSON", "copy-json")
                                }
                              >
                                {actionFeedback === "copy-json" ? (
                                  <ToolIcon name="check" />
                                ) : (
                                  <ToolIcon name="copy" />
                                )}
                                <span>
                                  {actionFeedback === "copy-json" ? "已复制" : "复制 JSON"}
                                </span>
                              </button>
                              <button
                                className={actionFeedback === "export-json" ? "is-success" : ""}
                                type="button"
                                onClick={exportJson}
                              >
                                {actionFeedback === "export-json" ? (
                                  <ToolIcon name="check" />
                                ) : (
                                  <ToolIcon name="download" />
                                )}
                                <span>
                                  {actionFeedback === "export-json" ? "已导出" : "导出文件"}
                                </span>
                              </button>
                            </div>
                          </div>
                          <pre>{JSON.stringify(result, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  </>
                ) : modbusFrame ? (
                  <div className="modbus-await" role="status">
                    <strong>请选择数据解释方式</strong>
                    <p>帧结构与 CRC 已通过，应用参数后将在此显示解析结果。</p>
                  </div>
                ) : (
                  <div className="result-empty">
                    <span>
                      <ToolIcon name="code" />
                    </span>
                    <h2>等待解析</h2>
                    <p>粘贴或导入报文，点击解析报文查看结果。</p>
                    <button type="button" onClick={() => setView("samples")}>
                      从样例开始
                    </button>
                  </div>
                )}
              </section>
            </div>
          </section>
        )}

        <section hidden={view !== "commands"} className="page command-page">
          <div className="page-heading">
            <div>
              <p className="eyebrow">COMMAND & CHECKSUM</p>
              <h1>指令生成</h1>
              <span>生成设备指令、Modbus 读取帧，或计算报文校验码。</span>
            </div>
            <button className="primary-link" type="button" onClick={() => setView("studio")}>
              返回解析工作台
            </button>
          </div>
          <div className="command-content-layout unified-command-layout">
            <CommandDirectory
              groups={directoryGroups}
              selected={selectedCommandKey}
              onSelect={selectDirectoryCommand}
            />
            <div className="unified-command-content">
              <div hidden={commandWorkspace === "device"}>
                <ChecksumTools mode={commandWorkspace} />
              </div>
              <div hidden={commandWorkspace !== "device"} className="command-workbench">
                <section className="panel command-form-panel">
                  <div className="panel-title">
                    <div>
                      <span className="step">01</span>
                      <strong>参数设置</strong>
                    </div>
                    <span className="byte-count">实时组帧</span>
                  </div>
                  <div className="command-function-context">
                    {commandVendor === "joymeter" ? "小口径水表 · 4G" : "大口径水表 · 4G"} ·{" "}
                    {activeCommandPresentation.formTitle}
                  </div>
                  <div className="command-generation-mode" role="group" aria-label="指令生成数量">
                    <button
                      className={commandGenerationMode === "single" ? "active" : ""}
                      type="button"
                      onClick={() => setCommandGenerationMode("single")}
                    >
                      <strong>单表生成</strong>
                      <span>查看完整字段</span>
                    </button>
                    <button
                      className={commandGenerationMode === "batch" ? "active" : ""}
                      type="button"
                      onClick={() => {
                        setCommandGenerationMode("batch");
                        if (!batchMeterInput.trim()) setBatchMeterInput(activeMeterAddress);
                      }}
                    >
                      <strong>批量表号</strong>
                      <span>生成后导出 Excel</span>
                    </button>
                  </div>
                  {commandVendor === "joymeter" ? (
                    <div className="command-form">
                      {renderMeterAddressField(
                        "仪表地址",
                        joymeterInput.meterAddress,
                        (meterAddress) =>
                          setJoymeterInput((current) => ({ ...current, meterAddress })),
                        "输入展示顺序的表号，最多 14 位；发送时自动按 7 字节 BCD、低字节在前编码。",
                      )}
                      {joymeterCommandType === "network" && (
                        <>
                          <div className="command-form-row">
                            <label>
                              <span>服务器 IP 地址</span>
                              <input
                                value={joymeterInput.ip}
                                inputMode="decimal"
                                onChange={(event) =>
                                  setJoymeterInput((current) => ({
                                    ...current,
                                    ip: event.target.value,
                                  }))
                                }
                              />
                              <small>默认：60.205.218.69</small>
                            </label>
                            <label>
                              <span>服务器端口</span>
                              <input
                                value={joymeterInput.port}
                                inputMode="numeric"
                                onChange={(event) =>
                                  setJoymeterInput((current) => ({
                                    ...current,
                                    port: event.target.value,
                                  }))
                                }
                              />
                              <small>范围 1–65535，按 2 字节小端编码。</small>
                            </label>
                          </div>
                          <div className="command-fixed-fields">
                            <span>固定协议参数</span>
                            <strong>控制码 24H</strong>
                            <strong>数据标识 A184H</strong>
                            <strong>协议 UDP · 01H</strong>
                            <strong>长度 0AH</strong>
                          </div>
                        </>
                      )}
                      {joymeterCommandType === "base" && (
                        <>
                          <label>
                            <span>基表读数（L）</span>
                            <input
                              value={joymeterInput.baseReading}
                              inputMode="numeric"
                              maxLength={8}
                              onChange={(event) =>
                                setJoymeterInput((current) => ({
                                  ...current,
                                  baseReading: event.target.value,
                                }))
                              }
                            />
                            <small>1–8 位整数；按 4 字节 BCD、小端编码，末尾固定追加 00H。</small>
                          </label>
                          <div className="command-fixed-fields">
                            <span>固定协议参数</span>
                            <strong>控制码 24H</strong>
                            <strong>数据标识 A171H</strong>
                            <strong>长度 08H</strong>
                          </div>
                        </>
                      )}
                      {joymeterCommandType === "valve" && (
                        <>
                          <fieldset className="command-choice">
                            <legend>阀门操作</legend>
                            <label className={joymeterInput.valveAction === "open" ? "active" : ""}>
                              <input
                                type="radio"
                                name="joymeter-valve-action"
                                checked={joymeterInput.valveAction === "open"}
                                onChange={() =>
                                  setJoymeterInput((current) => ({
                                    ...current,
                                    valveAction: "open",
                                  }))
                                }
                              />
                              <span>开阀</span>
                              <small>控制字 55H</small>
                            </label>
                            <label
                              className={joymeterInput.valveAction === "close" ? "active" : ""}
                            >
                              <input
                                type="radio"
                                name="joymeter-valve-action"
                                checked={joymeterInput.valveAction === "close"}
                                onChange={() =>
                                  setJoymeterInput((current) => ({
                                    ...current,
                                    valveAction: "close",
                                  }))
                                }
                              />
                              <span>关阀</span>
                              <small>控制字 99H</small>
                            </label>
                          </fieldset>
                          <div className="command-fixed-fields">
                            <span>固定协议参数</span>
                            <strong>控制码 24H</strong>
                            <strong>数据标识 A017H</strong>
                            <strong>长度 04H</strong>
                          </div>
                        </>
                      )}
                      {(joymeterCommandType === "reporting" || joymeterCommandType === "start") && (
                        <label>
                          <span>上报起始时间（0–23 点）</span>
                          <input
                            value={joymeterInput.startHour}
                            inputMode="numeric"
                            onChange={(event) =>
                              setJoymeterInput((current) => ({
                                ...current,
                                startHour: event.target.value,
                              }))
                            }
                          />
                          <small>按 1 字节 BCD 小时编码，例如 3 点为 03H。</small>
                        </label>
                      )}
                      {(joymeterCommandType === "reporting" ||
                        joymeterCommandType === "random") && (
                        <label>
                          <span>最大随机间隔（秒）</span>
                          <input
                            value={joymeterInput.maxRandomSeconds}
                            inputMode="numeric"
                            onChange={(event) =>
                              setJoymeterInput((current) => ({
                                ...current,
                                maxRandomSeconds: event.target.value,
                              }))
                            }
                          />
                          <small>范围 10–65535 秒，按 2 字节无符号整数、小端编码。</small>
                        </label>
                      )}
                      {(joymeterCommandType === "reporting" ||
                        joymeterCommandType === "period") && (
                        <label>
                          <span>上报周期（小时）</span>
                          <input
                            value={joymeterInput.reportPeriodHours}
                            inputMode="numeric"
                            onChange={(event) =>
                              setJoymeterInput((current) => ({
                                ...current,
                                reportPeriodHours: event.target.value,
                              }))
                            }
                          />
                          <small>范围 1–255 小时，按 1 字节无符号整数编码。</small>
                        </label>
                      )}
                      {["reporting", "start", "random", "period"].includes(joymeterCommandType) && (
                        <div className="command-fixed-fields">
                          <span>固定协议参数</span>
                          <strong>控制码 24H</strong>
                          <strong>数据标识 {joymeterMetadata[joymeterCommandType].di}</strong>
                          <strong>序列号 00H</strong>
                        </div>
                      )}
                      {commandGenerationMode === "single" && joymeterCommandPreview.error && (
                        <p className="command-error" role="alert">
                          {joymeterCommandPreview.error}
                        </p>
                      )}
                      <button
                        className="sample-button command-reset"
                        type="button"
                        onClick={() => setJoymeterInput({ ...defaultJoymeterInput })}
                      >
                        恢复 小口径水表 · 4G 示例参数
                      </button>
                    </div>
                  ) : commandType === "network" ? (
                    <div className="command-form">
                      {renderMeterAddressField(
                        "仪表地址",
                        commandInput.meterAddress,
                        (meterAddress) =>
                          setCommandInput((current) => ({ ...current, meterAddress })),
                        "输入展示顺序的表号，最多 14 位；发送时自动按低字节在前编码。",
                      )}
                      <div className="command-form-row">
                        <label>
                          <span>主用 IP 地址</span>
                          <input
                            value={commandInput.primaryIp}
                            inputMode="decimal"
                            onChange={(event) =>
                              setCommandInput((current) => ({
                                ...current,
                                primaryIp: event.target.value,
                              }))
                            }
                          />
                          <small>默认：60.205.218.69</small>
                        </label>
                        <label>
                          <span>主用端口</span>
                          <input
                            value={commandInput.primaryPort}
                            inputMode="numeric"
                            onChange={(event) =>
                              setCommandInput((current) => ({
                                ...current,
                                primaryPort: event.target.value,
                              }))
                            }
                          />
                          <small>范围 1–65535，自动转为 2 字节小端。</small>
                        </label>
                      </div>
                      <label>
                        <span>APN</span>
                        <input
                          value={commandInput.apn}
                          maxLength={16}
                          onChange={(event) =>
                            setCommandInput((current) => ({ ...current, apn: event.target.value }))
                          }
                        />
                        <small>最多 16 个 ASCII 字符，不足部分自动补 00H。</small>
                      </label>
                      <div className="command-fixed-fields">
                        <span>固定协议参数</span>
                        <strong>控制码 04H</strong>
                        <strong>数据标识 8110H</strong>
                        <strong>长度 3BH</strong>
                      </div>
                      {commandGenerationMode === "single" && commandPreview.error && (
                        <p className="command-error" role="alert">
                          {commandPreview.error}
                        </p>
                      )}
                      <button
                        className="sample-button command-reset"
                        type="button"
                        onClick={() => setCommandInput({ ...defaultCommandInput })}
                      >
                        恢复示例参数
                      </button>
                    </div>
                  ) : commandType === "sync" ? (
                    <div className="command-form">
                      {renderMeterAddressField(
                        "设备编号",
                        syncCommandInput.meterAddress,
                        (meterAddress) =>
                          setSyncCommandInput((current) => ({ ...current, meterAddress })),
                        "输入展示顺序的设备编号；发送时自动按 7 字节 BCD、低字节在前编码。",
                      )}
                      <label>
                        <span>当前累计流量（m³）</span>
                        <input
                          value={syncCommandInput.cumulativeFlow}
                          inputMode="decimal"
                          onChange={(event) =>
                            setSyncCommandInput((current) => ({
                              ...current,
                              cumulativeFlow: event.target.value,
                            }))
                          }
                        />
                        <small>最多 2 位小数；按 4 字节 BCD、小端编码，单位固定为 2CH。</small>
                      </label>
                      <div className="command-fixed-fields">
                        <span>固定协议参数</span>
                        <strong>控制码 04H</strong>
                        <strong>数据标识 A016H</strong>
                        <strong>长度 0008H</strong>
                        <strong>单位 2CH</strong>
                      </div>
                      {commandGenerationMode === "single" && syncCommandPreview.error && (
                        <p className="command-error" role="alert">
                          {syncCommandPreview.error}
                        </p>
                      )}
                      <button
                        className="sample-button command-reset"
                        type="button"
                        onClick={() =>
                          setSyncCommandInput({
                            meterAddress: "00430500003931",
                            cumulativeFlow: "10",
                          })
                        }
                      >
                        恢复示例参数
                      </button>
                    </div>
                  ) : commandType === "valve" ? (
                    <div className="command-form">
                      {renderMeterAddressField(
                        "设备编号",
                        valveCommandInput.meterAddress,
                        (meterAddress) =>
                          setValveCommandInput((current) => ({ ...current, meterAddress })),
                        "7 字节 BCD 地址，发送时低字节在前。",
                      )}
                      <fieldset className="command-choice">
                        <legend>阀门操作</legend>
                        <label className={valveCommandInput.action === "open" ? "active" : ""}>
                          <input
                            type="radio"
                            name="valve-action"
                            checked={valveCommandInput.action === "open"}
                            onChange={() =>
                              setValveCommandInput((current) => ({ ...current, action: "open" }))
                            }
                          />
                          <span>开阀</span>
                          <small>控制字 55H</small>
                        </label>
                        <label className={valveCommandInput.action === "close" ? "active" : ""}>
                          <input
                            type="radio"
                            name="valve-action"
                            checked={valveCommandInput.action === "close"}
                            onChange={() =>
                              setValveCommandInput((current) => ({ ...current, action: "close" }))
                            }
                          />
                          <span>关阀</span>
                          <small>控制字 99H</small>
                        </label>
                      </fieldset>
                      <div className="command-fixed-fields">
                        <span>固定协议参数</span>
                        <strong>控制码 04H</strong>
                        <strong>数据标识 A017H</strong>
                        <strong>长度 0004H</strong>
                      </div>
                      {commandGenerationMode === "single" && valveCommandPreview.error && (
                        <p className="command-error" role="alert">
                          {valveCommandPreview.error}
                        </p>
                      )}
                    </div>
                  ) : commandType === "schedule" ? (
                    <div className="command-form command-schedule-form">
                      {renderMeterAddressField(
                        "设备编号",
                        scheduleMeterAddress,
                        setScheduleMeterAddress,
                        "每小时可设置两个上传分钟值；留空表示该时刻停用并编码为 FFH。",
                      )}
                      <div className="schedule-tools">
                        <strong>24 小时上传分钟</strong>
                        <div>
                          <button
                            type="button"
                            onClick={() =>
                              setUploadSchedule(Array.from({ length: 24 }, () => ["0", "30"]))
                            }
                          >
                            设为整点 / 半点
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setUploadSchedule(Array.from({ length: 24 }, () => ["", ""]))
                            }
                          >
                            全部停用
                          </button>
                        </div>
                      </div>
                      <div className="schedule-grid">
                        <header>
                          <span>小时</span>
                          <span>分钟值 1</span>
                          <span>分钟值 2</span>
                        </header>
                        {uploadSchedule.map(([first, second], hour) => (
                          <div className="schedule-row" key={hour}>
                            <strong>{hour.toString().padStart(2, "0")} 时</strong>
                            <input
                              aria-label={`${hour} 点第一个上传分钟`}
                              inputMode="numeric"
                              placeholder="停用"
                              value={first}
                              onChange={(event) =>
                                setUploadSchedule((current) =>
                                  current.map((pair, index) =>
                                    index === hour ? [event.target.value, pair[1]] : pair,
                                  ),
                                )
                              }
                            />
                            <input
                              aria-label={`${hour} 点第二个上传分钟`}
                              inputMode="numeric"
                              placeholder="停用"
                              value={second}
                              onChange={(event) =>
                                setUploadSchedule((current) =>
                                  current.map((pair, index) =>
                                    index === hour ? [pair[0], event.target.value] : pair,
                                  ),
                                )
                              }
                            />
                          </div>
                        ))}
                      </div>
                      <div className="command-fixed-fields">
                        <span>固定协议参数</span>
                        <strong>控制码 04H</strong>
                        <strong>数据标识 8104H</strong>
                        <strong>长度 0033H</strong>
                      </div>
                      {commandGenerationMode === "single" && scheduleCommandPreview.error && (
                        <p className="command-error" role="alert">
                          {scheduleCommandPreview.error}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="command-form">
                      {renderMeterAddressField(
                        "设备编号",
                        intervalCommandInput.meterAddress,
                        (meterAddress) =>
                          setIntervalCommandInput((current) => ({ ...current, meterAddress })),
                        "7 字节 BCD 地址，发送时低字节在前。",
                      )}
                      <label>
                        <span>数据采集间隔（分钟）</span>
                        <input
                          value={intervalCommandInput.intervalMinutes}
                          inputMode="numeric"
                          onChange={(event) =>
                            setIntervalCommandInput((current) => ({
                              ...current,
                              intervalMinutes: event.target.value,
                            }))
                          }
                        />
                        <small>范围 1–255，按 1 字节无符号整数写入。</small>
                      </label>
                      <div className="command-fixed-fields">
                        <span>固定协议参数</span>
                        <strong>控制码 04H</strong>
                        <strong>数据标识 8105H</strong>
                        <strong>长度 0004H</strong>
                      </div>
                      {commandGenerationMode === "single" && intervalCommandPreview.error && (
                        <p className="command-error" role="alert">
                          {intervalCommandPreview.error}
                        </p>
                      )}
                      <button
                        className="sample-button command-reset"
                        type="button"
                        onClick={() =>
                          setIntervalCommandInput({
                            meterAddress: "00430500003931",
                            intervalMinutes: "60",
                          })
                        }
                      >
                        恢复示例参数
                      </button>
                    </div>
                  )}
                </section>

                <section className="panel command-result-panel">
                  <div className="panel-title">
                    <div>
                      <span className="step">02</span>
                      <strong>生成结果</strong>
                    </div>
                    <span
                      className={`command-state${commandGenerationMode === "batch" ? (batchReady ? " valid" : " invalid") : activeCommandPreview.result ? " valid" : " invalid"}`}
                    >
                      {commandGenerationMode === "batch"
                        ? batchReady
                          ? `● ${batchCommandRows.length} 条可导出`
                          : "● 请检查批量表号或参数"
                        : activeCommandPreview.result
                          ? "● 长度与校验通过"
                          : "● 等待有效参数"}
                    </span>
                  </div>
                  {commandGenerationMode === "batch" ? (
                    <div className="batch-command-result">
                      <div className="batch-command-summary">
                        <article>
                          <span>指令类型</span>
                          <strong>{commandMetadata.label}</strong>
                          <small>{commandMetadata.di}</small>
                        </article>
                        <article>
                          <span>有效表号</span>
                          <strong>{batchMeterState.valid.length}</strong>
                          <small>最多 500 个</small>
                        </article>
                        <article>
                          <span>可导出</span>
                          <strong>{batchCommandRows.length - batchBuildErrors.length}</strong>
                          <small>
                            {batchBuildErrors.length
                              ? `${batchBuildErrors.length} 条组帧失败`
                              : "全部校验通过"}
                          </small>
                        </article>
                        <button
                          className={actionFeedback === "export-command" ? "is-success" : ""}
                          type="button"
                          disabled={!batchReady}
                          onClick={exportBatchCommands}
                        >
                          <ToolIcon
                            name={actionFeedback === "export-command" ? "check" : "download"}
                          />
                          <span>
                            {actionFeedback === "export-command" ? "已导出 Excel" : "导出 Excel"}
                          </span>
                        </button>
                      </div>
                      {batchCommandRows.length > 0 ? (
                        <div className="batch-command-table-wrap">
                          <table className="batch-command-table">
                            <thead>
                              <tr>
                                <th>序号</th>
                                <th>表号</th>
                                <th>状态</th>
                                <th>完整 HEX 指令</th>
                              </tr>
                            </thead>
                            <tbody>
                              {batchCommandRows.slice(0, 50).map((row, index) => (
                                <tr key={row.meterAddress}>
                                  <td>{index + 1}</td>
                                  <td>
                                    <code>{row.meterAddress}</code>
                                  </td>
                                  <td className={row.result ? "valid" : "invalid"}>
                                    {row.result ? "可导出" : row.error}
                                  </td>
                                  <td>
                                    <code>{row.result?.compactHex ?? "—"}</code>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {batchCommandRows.length > 50 && (
                            <p>当前预览前 50 条，Excel 将导出全部 {batchCommandRows.length} 条。</p>
                          )}
                        </div>
                      ) : (
                        <div className="command-empty">
                          <strong>输入批量表号</strong>
                          <p>每行粘贴一个表号，右侧会立即生成并校验。</p>
                        </div>
                      )}
                      {!batchReady && batchCommandRows.length > 0 && (
                        <p className="batch-export-hint">
                          修正格式错误或指令参数后，才可导出 Excel，避免遗漏设备。
                        </p>
                      )}
                    </div>
                  ) : activeCommandPreview.result ? (
                    <>
                      <div className="command-summary">
                        <div>
                          <span>{activeCommandPresentation.primaryLabel}</span>
                          <strong>{activeCommandPresentation.primaryValue}</strong>
                        </div>
                        <div>
                          <span>{activeCommandPresentation.secondaryLabel}</span>
                          <strong>{activeCommandPresentation.secondaryValue}</strong>
                        </div>
                        <div>
                          <span>校验码 CS</span>
                          <strong>{activeCommandPreview.result.checksum}</strong>
                        </div>
                      </div>
                      <div className="command-output">
                        <div className="command-output-head">
                          <div>
                            <strong>完整 HEX 指令</strong>
                            <span>{activeCommandPresentation.outputHint}</span>
                          </div>
                          <button
                            className={actionFeedback === "copy-command" ? "is-success" : ""}
                            type="button"
                            onClick={() =>
                              copyText(
                                activeCommandPreview.result!.compactHex,
                                activeCommandPresentation.copyLabel,
                                "copy-command",
                              )
                            }
                          >
                            <ToolIcon name={actionFeedback === "copy-command" ? "check" : "copy"} />
                            {actionFeedback === "copy-command" ? "已复制" : "复制指令"}
                          </button>
                        </div>
                        <textarea
                          readOnly
                          value={activeCommandPreview.result.compactHex}
                          aria-label={activeCommandPresentation.copyLabel}
                        />
                      </div>
                      <div className="command-explanation">
                        <header>
                          <strong>字段组成</strong>
                          <span>{activeCommandPresentation.fieldHint}</span>
                        </header>
                        <FieldTable
                          fields={activeCommandPreview.result.fields}
                          selectedField={selectedField}
                          onSelect={setSelectedField}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="command-empty">
                      <strong>参数尚未完成</strong>
                      <p>修正左侧提示后会自动生成完整指令。</p>
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>
        </section>

        {(view === "library" || view === "samples") && (
          <section className="page protocol-center-page">
            <div className="page-heading">
              <div>
                <p className="eyebrow">PROTOCOL CENTER</p>
                <h1>协议中心</h1>
                <span>集中查看已接入协议的能力、样例与解析入口。</span>
              </div>
              <button className="primary-link" type="button" onClick={() => setView("studio")}>
                返回工作台
              </button>
            </div>
            <div className="protocol-center-toolbar">
              <div className="protocol-center-tabs" role="tablist" aria-label="协议中心内容">
                <button
                  className={view === "library" ? "active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={view === "library"}
                  onClick={() => setView("library")}
                >
                  <NavIcon name="library" />
                  <span>协议能力</span>
                  <em>{parsers.length}</em>
                </button>
                <button
                  className={view === "samples" ? "active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={view === "samples"}
                  onClick={() => setView("samples")}
                >
                  <NavIcon name="sample" />
                  <span>样例帧</span>
                  <em>{sampleList.length}</em>
                </button>
              </div>
              <label className="protocol-center-search">
                <span className="visually-hidden">搜索协议中心</span>
                <input
                  className="search-input"
                  value={protocolCenterSearch}
                  onChange={(event) => setProtocolCenterSearch(event.target.value)}
                  placeholder={view === "library" ? "搜索协议、厂商或能力" : "搜索样例、协议或 DI"}
                />
                {protocolCenterSearch && (
                  <button type="button" onClick={() => setProtocolCenterSearch("")}>
                    清除
                  </button>
                )}
              </label>
            </div>
            <div className="protocol-center-layout">
              <aside
                className="protocol-center-directory"
                aria-label={view === "library" ? "协议目录" : "样例目录"}
              >
                <header>
                  <strong>{view === "library" ? "协议目录" : "样例目录"}</strong>
                  <span>
                    {view === "library" ? visibleProtocols.length : visibleSamples.length} 项
                  </span>
                </header>
                {protocolCenterVendors.map((vendor) => {
                  const vendorProtocols = visibleProtocols.filter(
                    (parser) => protocolCenterMeta[parser.id]?.vendor === vendor,
                  );
                  const vendorSamples = visibleSamples.filter(
                    (sample) => protocolCenterMeta[sample.protocolId]?.vendor === vendor,
                  );
                  const entries = view === "library" ? vendorProtocols : vendorSamples;
                  if (!entries.length) return null;
                  return (
                    <section className="protocol-directory-group" key={vendor}>
                      <h2>{vendor}</h2>
                      <div>
                        {view === "library"
                          ? vendorProtocols.map((parser) => (
                              <button
                                className={activeProtocol?.id === parser.id ? "active" : ""}
                                type="button"
                                key={parser.id}
                                onClick={() => setSelectedProtocolId(parser.id)}
                              >
                                <span className="protocol-directory-mark">
                                  {protocolCenterMeta[parser.id]?.short.slice(0, 2)}
                                </span>
                                <span>
                                  <strong>
                                    {protocolCenterMeta[parser.id]?.product ?? parser.name}
                                  </strong>
                                  <small>{protocolCenterMeta[parser.id]?.vendor}</small>
                                </span>
                                <i aria-hidden="true" />
                              </button>
                            ))
                          : vendorSamples.map((sample) => (
                              <button
                                className={activeSample?.id === sample.id ? "active" : ""}
                                type="button"
                                key={sample.id}
                                onClick={() => setSelectedSampleId(sample.id)}
                              >
                                <span className="protocol-directory-mark">
                                  {protocolCenterMeta[sample.protocolId]?.short.slice(0, 2)}
                                </span>
                                <span>
                                  <strong>{sample.name}</strong>
                                  <small>{parseHex(sample.value).length} Bytes</small>
                                </span>
                                <i aria-hidden="true" />
                              </button>
                            ))}
                      </div>
                    </section>
                  );
                })}
                {((view === "library" && !visibleProtocols.length) ||
                  (view === "samples" && !visibleSamples.length)) && (
                  <div className="protocol-directory-empty">
                    <strong>没有匹配结果</strong>
                    <span>换个关键词试试</span>
                  </div>
                )}
              </aside>

              {view === "library"
                ? activeProtocol && (
                    <article className="protocol-center-detail">
                      <header className="protocol-detail-hero">
                        <div>
                          <span>{protocolCenterMeta[activeProtocol.id]?.vendor}</span>
                          <h2>{activeProtocol.name}</h2>
                          <span className="protocol-description">
                            {protocolCenterMeta[activeProtocol.id]?.product}
                          </span>
                        </div>
                        <strong className="protocol-ready">
                          <i />
                          可用
                        </strong>
                      </header>
                      <div className="protocol-detail-stats">
                        <div>
                          <span>产品方向</span>
                          <strong>{protocolCenterMeta[activeProtocol.id]?.product}</strong>
                        </div>
                        <div>
                          <span>协议分类</span>
                          <strong>
                            {activeProtocol.category === "water"
                              ? "水务计量"
                              : activeProtocol.category === "electric"
                                ? "电能计量"
                                : activeProtocol.category === "industrial"
                                  ? "工业通信"
                                  : "网关"}
                          </strong>
                        </div>
                        <div>
                          <span>已接入能力</span>
                          <strong>{parserCapabilities[activeProtocol.id]?.length ?? 0} 项</strong>
                        </div>
                        <div>
                          <span>关联样例</span>
                          <strong>
                            {
                              sampleList.filter((sample) => sample.protocolId === activeProtocol.id)
                                .length
                            }{" "}
                            条
                          </strong>
                        </div>
                      </div>
                      <section className="protocol-capabilities">
                        <header>
                          <div>
                            <strong>支持能力</strong>
                            <span>自动识别与字段解析范围</span>
                          </div>
                        </header>
                        <ul>
                          {parserCapabilities[activeProtocol.id]?.map((item) => (
                            <li key={item}>
                              <span>✓</span>
                              <strong>{item}</strong>
                            </li>
                          ))}
                        </ul>
                      </section>
                      <section className="protocol-related-samples">
                        <header>
                          <div>
                            <strong>关联样例</strong>
                            <span>使用真实格式验证解析链路</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const firstSample = sampleList.find(
                                (sample) => sample.protocolId === activeProtocol.id,
                              );
                              if (firstSample) setSelectedSampleId(firstSample.id);
                              setView("samples");
                            }}
                          >
                            查看全部样例
                          </button>
                        </header>
                        {sampleList.filter((sample) => sample.protocolId === activeProtocol.id)
                          .length ? (
                          <div>
                            {sampleList
                              .filter((sample) => sample.protocolId === activeProtocol.id)
                              .slice(0, 3)
                              .map((sample) => (
                                <button
                                  type="button"
                                  key={sample.id}
                                  onClick={() => {
                                    setSelectedSampleId(sample.id);
                                    setView("samples");
                                  }}
                                >
                                  <span>
                                    <strong>{sample.name}</strong>
                                    <small>{sample.description}</small>
                                  </span>
                                  <em>{parseHex(sample.value).length} Bytes</em>
                                </button>
                              ))}
                          </div>
                        ) : (
                          <p>当前协议暂无内置样例，可直接进入自动解析。</p>
                        )}
                      </section>
                      <footer className="protocol-detail-actions">
                        <button type="button" onClick={() => setView("studio")}>
                          进入自动解析
                        </button>
                      </footer>
                    </article>
                  )
                : activeSample && (
                    <article className="protocol-center-detail sample-detail">
                      <header className="protocol-detail-hero">
                        <div>
                          <span>
                            {protocolCenterMeta[activeSample.protocolId]?.vendor} ·{" "}
                            {protocolCenterMeta[activeSample.protocolId]?.product}
                          </span>
                          <h2>{activeSample.name}</h2>
                          <span className="protocol-description">
                            {protocolCenterMeta[activeSample.protocolId]?.product}
                          </span>
                        </div>
                        <strong className="sample-byte-badge">
                          {parseHex(activeSample.value).length} Bytes
                        </strong>
                      </header>
                      <p className="sample-detail-description">{activeSample.description}</p>
                      <section className="sample-code-panel">
                        <header>
                          <div>
                            <strong>完整 HEX 报文</strong>
                            <span>保留原始字节顺序，可直接复制或载入工作台</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => copyText(activeSample.value, "样例报文")}
                          >
                            复制 HEX
                          </button>
                        </header>
                        <code>{activeSample.value}</code>
                      </section>
                      <div className="sample-detail-info">
                        <div>
                          <span>所属厂商</span>
                          <strong>{protocolCenterMeta[activeSample.protocolId]?.vendor}</strong>
                        </div>
                        <div>
                          <span>协议模块</span>
                          <strong>{protocolCenterMeta[activeSample.protocolId]?.product}</strong>
                        </div>
                        <div>
                          <span>数据长度</span>
                          <strong>{parseHex(activeSample.value).length} Bytes</strong>
                        </div>
                      </div>
                      <footer className="protocol-detail-actions">
                        <button type="button" onClick={() => useSample(activeSample)}>
                          载入并解析
                        </button>
                      </footer>
                    </article>
                  )}
            </div>
          </section>
        )}

        {view === "records" && (
          <RecordsPage
            records={records}
            recordStorageNotice={recordStorageNotice}
            recordSearch={recordSearch}
            recordProtocol={recordProtocol}
            recordProtocols={recordProtocols}
            visibleRecords={visibleRecords}
            expandedRecordId={expandedRecordId}
            setRecordSearch={setRecordSearch}
            setRecordProtocol={setRecordProtocol}
            setExpandedRecordId={setExpandedRecordId}
            clearRecords={clearRecords}
            reuseRecord={reuseRecord}
            deleteRecord={deleteRecord}
            copyText={copyText}
            setView={setView}
            emptyIcon={<NavIcon name="history" />}
          />
        )}
      </div>

      {/* 手机端使用固定底部导航，避免侧栏隐藏后协议中心和记录失去入口。 */}
      <nav className="mobile-navigation" aria-label="手机端主导航">
        <button
          className={view === "studio" ? "active" : ""}
          type="button"
          aria-current={view === "studio" ? "page" : undefined}
          onClick={() => setView("studio")}
        >
          <NavIcon name="parser" />
          <span>协议解析</span>
        </button>
        <button
          className={view === "commands" ? "active" : ""}
          type="button"
          aria-current={view === "commands" ? "page" : undefined}
          onClick={() => setView("commands")}
        >
          <NavIcon name="command" />
          <span>指令生成</span>
        </button>
        <button
          className={view === "library" || view === "samples" ? "active" : ""}
          type="button"
          aria-current={view === "library" || view === "samples" ? "page" : undefined}
          onClick={() => setView("library")}
        >
          <NavIcon name="library" />
          <span>协议中心</span>
        </button>
        <button
          className={view === "records" ? "active" : ""}
          type="button"
          aria-current={view === "records" ? "page" : undefined}
          onClick={() => setView("records")}
        >
          <NavIcon name="history" />
          <span>解析记录</span>
        </button>
      </nav>
      {toast && (
        <div className="toast" role="status">
          ✓ {toast}
        </div>
      )}
    </main>
  );
}
