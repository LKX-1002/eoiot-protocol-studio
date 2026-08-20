import {
  bcdLittleEndian,
  checksumDiagnostics,
  field,
  findFrameStart,
  formatNumber,
  hex,
  hexByte,
  meterAddress,
  safeSlice,
  validateFrameEnvelope,
} from "./bytes";
import { getWaterMeterType } from "./meter-types";
import type { Diagnostic, ParseResult, ProtocolParser } from "./types";

/** Joymeter 小口径水表实际使用的控制码。 */
const CONTROL_NAMES: Record<number, string> = {
  0x21: "读数据请求",
  0xa1: "读数据应答",
  0x24: "写数据请求",
  0xa4: "写数据应答",
  0x81: "主动上报",
};

/** 协议文档中已经定义的数据标识；未知 DI 仍可按原始数据展示。 */
const DI_NAMES: Record<string, string> = {
  "9020": "主动上报综合数据",
  A06D: "读取当前累计流量",
  A070: "读取结算日累计流量",
  A071: "读取阀门状态",
  A072: "读取设备状态",
  A073: "读取通信参数",
  A074: "读取冻结参数",
  A075: "读取设备版本",
  A080: "读取设备时间",
  A171: "设置结算日",
  A172: "设置阀门",
  A173: "设置通信参数",
  A174: "设置冻结参数",
  A180: "设置设备时间",
  A181: "设置上报参数",
  A182: "设置服务器参数",
  A183: "设置设备参数",
  A184: "设备维护命令",
  A017: "阀门控制（新版）",
  "17A0": "阀门控制（兼容版）",
};

/** 计量单位换算为立方米时使用的倍率。 */
const FLOW_UNITS: Record<number, { label: string; cubicMeterFactor: number; sourceLabel: string }> = {
  0x29: { label: "m³", cubicMeterFactor: 0.001, sourceLabel: "升（L）" },
  0x2c: { label: "m³", cubicMeterFactor: 0.01, sourceLabel: "10 升" },
  0x2d: { label: "m³", cubicMeterFactor: 0.1, sourceLabel: "100 升" },
  0x2e: { label: "m³", cubicMeterFactor: 1, sourceLabel: "立方米" },
};

interface FlowValue {
  value: number | null;
  unitCode: number;
  unitLabel: string;
  sourceLabel: string;
}

/** 4G 通信模组代码位于模式字节的高 4 Bits。 */
const FOUR_G_MODULES: Record<number, string> = {
  0x2: "307A",
  0x3: "307R",
  0x4: "307R",
  0x5: "307C",
};

/** 上报触发原因位于模式字节的低 4 Bits。 */
const FOUR_G_REPORT_REASONS: Record<number, string> = {
  0x0: "周期上报",
  0x1: "红外触发上报",
  0x2: "按键触发上报",
  0x3: "重复上报",
  0x4: "异常上报",
};

/** 4G 状态的单个半字节定义，FH 代表成功，其余值代表具体失败阶段。 */
const FOUR_G_UPLOAD_RESULTS: Record<number, string> = {
  0xf: "上报成功",
  0x1: "串口通讯失败",
  0x2: "入网失败",
  0x3: "平台未注册或注册 NB&4G 平台失败",
  0x4: "数据发送失败",
};

interface FourGMode {
  raw: string;
  moduleCode: number;
  moduleName: string;
  reportCode: number;
  reportReason: string;
  summary: string;
}

/** 将模式字节拆为“4G 模组 + 上报触发原因”。例如 32H = 307R + 按键触发上报。 */
function parseFourGMode(value: number | undefined): FourGMode {
  const safeValue = value ?? 0;
  const moduleCode = (safeValue >> 4) & 0x0f;
  const reportCode = safeValue & 0x0f;
  const moduleName = FOUR_G_MODULES[moduleCode] ?? `未知模组代码 ${moduleCode}`;
  const reportReason = FOUR_G_REPORT_REASONS[reportCode] ?? `未知上报类型 ${reportCode}`;
  return {
    raw: `${hexByte(safeValue)}H`,
    moduleCode,
    moduleName,
    reportCode,
    reportReason,
    summary: `${moduleName} · ${reportReason}`,
  };
}

interface FourGStatus {
  history: string[];
  latest: string;
  uploadCount: number;
  summary: string;
}

/**
 * 4G 状态共 5 字节：前 4 字节包含 8 条半字节状态，最高 4 Bits 是最近一次；
 * 最后 1 字节是模块上报总次数，按普通无符号十六进制整数读取，而不是 BCD。
 */
function parseFourGStatus(raw: number[]): FourGStatus {
  const statusBytes = raw.slice(0, 4);
  const nibbles = statusBytes.flatMap((value) => [(value >> 4) & 0x0f, value & 0x0f]);
  const history = nibbles.map((code, index) => {
    const label = FOUR_G_UPLOAD_RESULTS[code] ?? `未知状态 ${code.toString(16).toUpperCase()}H`;
    return `第 ${index + 1} 近：${label}`;
  });
  const latest = nibbles.length ? (FOUR_G_UPLOAD_RESULTS[nibbles[0]] ?? `未知状态 ${nibbles[0].toString(16).toUpperCase()}H`) : "未提供";
  const uploadCount = raw[4] ?? 0;
  return { history, latest, uploadCount, summary: `最近一次：${latest} · 累计上报 ${uploadCount} 次` };
}

/** 4 字节低位在前 BCD + 1 字节单位，统一换算成 m³。 */
function parseFlow(bytes: number[], offset: number): FlowValue {
  const raw = bcdLittleEndian(safeSlice(bytes, offset, 4), 0);
  const unitCode = bytes[offset + 4] ?? -1;
  const unit = FLOW_UNITS[unitCode];
  return {
    value: raw === null || !unit ? null : raw * unit.cubicMeterFactor,
    unitCode,
    unitLabel: unit?.label ?? "未知单位",
    sourceLabel: unit?.sourceLabel ?? "未定义单位码",
  };
}

/** Joymeter 时间顺序为秒、分、时、日、月、年、世纪。 */
function parseJoymeterTime(raw: number[]): string {
  if (raw.length !== 7 || raw.some((value) => value !== 0xff && ((value & 0x0f) > 9 || (value >> 4) > 9))) return "—";
  if (raw.every((value) => value === 0xff)) return "未提供";
  const [second, minute, hour, day, month, year, century] = raw.map(hexByte);
  return `${century}${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/** 两字节设备状态，低位在前；位定义来自 Joymeter 协议。 */
function parseStatus(raw: number[]) {
  const status = (raw[0] ?? 0) | ((raw[1] ?? 0) << 8);
  const valveCode = status & 0x03;
  const valveStatus = valveCode === 0 ? "开启" : valveCode === 1 ? "关闭" : valveCode === 2 ? "执行中" : "阀门异常";
  const alarms = [
    [2, "电池欠压"], [3, "空管"], [4, "气泡"], [5, "温度传感器异常"],
    [6, "存储异常"], [7, "磁干扰"], [8, "拆卸告警"], [9, "过流告警"],
    [10, "反向流量"], [11, "流量传感器异常"], [12, "漏水告警"], [13, "反向安装"],
  ].filter(([bit]) => (status & (1 << Number(bit))) !== 0).map(([, label]) => String(label));
  return { valveStatus, alarms, status };
}

/** 判断帧中的 CS 是否与实际累加和一致，用于识别评分。 */
function hasValidChecksum(bytes: number[], start: number): boolean {
  if (start < 0 || bytes.at(-1) !== 0x16 || bytes.length < 2) return false;
  const calculated = bytes.slice(start, -2).reduce((sum, value) => (sum + value) & 0xff, 0);
  return bytes.at(-2) === calculated;
}

/** 校验地址 BCD；全 AA 是协议允许的广播地址。 */
function isValidAddress(address: number[]): boolean {
  if (address.length !== 7) return false;
  if (address.every((value) => value === 0xaa)) return true;
  return address.every((value) => (value & 0x0f) <= 9 && (value >> 4) <= 9);
}

export const cjt188Parser: ProtocolParser = {
  id: "cjt188-small",
  name: "Joymeter · CJ/T 188 小口径水表",
  category: "water",
  status: "ready",

  /** 小口径使用 1 字节 L：从 68 起的总字节数固定等于 L + 13。 */
  detect(bytes) {
    const start = findFrameStart(bytes);
    if (start < 0 || bytes.length < start + 13) return 0;
    const dataLength = bytes[start + 10] ?? -1;
    if (bytes.length - start !== dataLength + 13) return 5;
    let score = 55;
    if (getWaterMeterType(bytes[start + 1])) score += 10;
    if (CONTROL_NAMES[bytes[start + 9]]) score += 10;
    const di = hex(safeSlice(bytes, start + 11, 2)).replaceAll(" ", "");
    if (DI_NAMES[di]) score += 10;
    if (isValidAddress(safeSlice(bytes, start + 2, 7))) score += 5;
    if (hasValidChecksum(bytes, start)) score += 10;
    return Math.min(score, 100);
  },

  /** 完整校验帧边界、1 字节长度、地址、控制码和数据区最小长度。 */
  validate(bytes) {
    const start = findFrameStart(bytes);
    validateFrameEnvelope(bytes, start);
    const meterType = getWaterMeterType(bytes[start + 1]);
    if (!meterType) throw new Error(`仪表类型错误：${hexByte(bytes[start + 1] ?? 0)}H 不属于水表类型 10H–19H。`);
    if (!isValidAddress(safeSlice(bytes, start + 2, 7))) throw new Error("表地址错误：应为 7 字节 BCD 地址或全 AA 广播地址。");
    const control = bytes[start + 9];
    if (!CONTROL_NAMES[control]) throw new Error(`控制码错误：Joymeter 小口径协议未定义 ${hexByte(control ?? 0)}H。`);
    const declaredLength = bytes[start + 10];
    const actualLength = bytes.length - start - 13;
    if (declaredLength !== actualLength) throw new Error(`长度字段错误：小口径帧声明 DATA 为 ${declaredLength} Bytes，实际为 ${actualLength} Bytes。`);
    if (declaredLength < 2) throw new Error("数据区错误：DATA 至少应包含 2 字节数据标识 DI。");
    const di = hex(safeSlice(bytes, start + 11, 2)).replaceAll(" ", "");
    if (di === "9020" && declaredLength < 38) throw new Error(`数据区不完整：9020 主动上报应至少为 38 Bytes，当前只有 ${declaredLength} Bytes。`);
  },

  /** 解析公共帧头，并对 9020 主动上报展开全部字段。 */
  parse(bytes): ParseResult {
    const start = findFrameStart(bytes);
    const type = getWaterMeterType(bytes[start + 1]);
    if (!type) throw new Error("无法解析仪表类型。");
    const controlOffset = start + 9;
    const lengthOffset = start + 10;
    const dataOffset = start + 11;
    const dataLength = bytes[lengthOffset];
    const checksumOffset = dataOffset + dataLength;
    const di = hex(safeSlice(bytes, dataOffset, 2)).replaceAll(" ", "");
    const diagnostics: Diagnostic[] = checksumDiagnostics(bytes, start);
    const fields: ParseResult["fields"] = [];

    if (start > 0) fields.push(field(bytes, 0, start, "唤醒字节", `${start} 个 FE`, { note: "不参与 CS 计算", tone: "meta" }));
    fields.push(
      field(bytes, start, 1, "帧起始符", "68H", { tone: "header" }),
      field(bytes, start + 1, 1, "仪表类型", type.label, { note: type.codeLabel, tone: "meta" }),
      field(bytes, start + 2, 7, "表地址", meterAddress(bytes, start), { note: "7 字节 BCD，低位在前", tone: "meta" }),
      field(bytes, controlOffset, 1, "控制码", CONTROL_NAMES[bytes[controlOffset]], { note: `${hexByte(bytes[controlOffset])}H`, tone: "header" }),
      field(bytes, lengthOffset, 1, "数据长度 L", `${dataLength} Bytes`, { note: "仅表示 DATA 长度", tone: "meta" }),
      field(bytes, dataOffset, 2, "数据标识 DI", di, { note: DI_NAMES[di] ?? "协议扩展/暂未命名", tone: "meta" }),
    );

    let currentFlow: FlowValue | null = null;
    let settlementFlow: FlowValue | null = null;
    let reverseFlow: FlowValue | null = null;
    let meterTime = "—";
    let valveStatus = "—";
    let statusText = "—";
    let fourGMode: FourGMode | null = null;
    let fourGStatus: FourGStatus | null = null;
    let rssi: string | number = "—";
    let rsrq: string | number = "—";
    let rsrp: string | number = "—";

    if (di === "9020") {
      const serialOffset = dataOffset + 2;
      const currentOffset = dataOffset + 3;
      const settlementOffset = dataOffset + 8;
      const timeOffset = dataOffset + 13;
      const statusOffset = dataOffset + 20;
      const reverseOffset = dataOffset + 24;
      const status = parseStatus(safeSlice(bytes, statusOffset, 2));
      currentFlow = parseFlow(bytes, currentOffset);
      settlementFlow = parseFlow(bytes, settlementOffset);
      reverseFlow = parseFlow(bytes, reverseOffset);
      meterTime = parseJoymeterTime(safeSlice(bytes, timeOffset, 7));
      valveStatus = status.valveStatus;
      statusText = status.alarms.join("、") || "正常";
      fourGMode = parseFourGMode(bytes[dataOffset + 29]);
      fourGStatus = parseFourGStatus(safeSlice(bytes, dataOffset + 30, 5));
      // 4G 信号指标按普通无符号 HEX 整数读取，例如 10H=16、0CH=12、19H=25。
      rssi = bytes[dataOffset + 35] ?? "—";
      rsrq = bytes[dataOffset + 36] ?? "—";
      rsrp = bytes[dataOffset + 37] ?? "—";

      fields.push(
        field(bytes, serialOffset, 1, "流水号 SER", String(bytes[serialOffset]), { tone: "meta" }),
        field(bytes, currentOffset, 4, "总累积量", formatNumber(currentFlow.value, 3), { unit: "m³", note: "原始值为 4 字节 BCD，低位在前", tone: "value" }),
        field(bytes, currentOffset + 4, 1, "单位 L", currentFlow.sourceLabel, { note: `单位码 ${hexByte(currentFlow.unitCode)}H`, tone: "value" }),
        field(bytes, settlementOffset, 4, "结算日流量", formatNumber(settlementFlow.value, 3), { unit: "m³", note: "原始值为 4 字节 BCD，低位在前", tone: "value" }),
        field(bytes, settlementOffset + 4, 1, "单位 L", settlementFlow.sourceLabel, { note: `单位码 ${hexByte(settlementFlow.unitCode)}H`, tone: "value" }),
        field(bytes, timeOffset, 7, "上报时间", meterTime, { note: "秒、分、时、日、月、年、世纪，BCD", tone: "meta" }),
        field(bytes, statusOffset, 2, "状态 ST", `${valveStatus} / ${statusText}`, { note: `原始状态字 0x${status.status.toString(16).padStart(4, "0").toUpperCase()}`, tone: "status" }),
        field(bytes, dataOffset + 22, 1, "冻结控制字", bytes[dataOffset + 22] === 0x01 ? "开启冻结" : bytes[dataOffset + 22] === 0x00 ? "关闭冻结" : "未知状态", { note: `${hexByte(bytes[dataOffset + 22])}H：00=关闭，01=开启`, tone: "meta" }),
        field(bytes, dataOffset + 23, 1, "复位次数", String(bytes[dataOffset + 23]), { note: "无符号整数", tone: "meta" }),
        field(bytes, reverseOffset, 4, "反向流量", formatNumber(reverseFlow.value, 3), { unit: "m³", note: "4 字节 BCD，低位在前", tone: "value" }),
        field(bytes, reverseOffset + 4, 1, "单位 L", reverseFlow.sourceLabel, { note: `单位码 ${hexByte(reverseFlow.unitCode)}H`, tone: "value" }),
        field(bytes, dataOffset + 29, 1, "4G 模式", fourGMode.summary, { note: `${fourGMode.raw}：高 4 Bits=${fourGMode.moduleCode}，低 4 Bits=${fourGMode.reportCode}`, tone: "meta" }),
        field(bytes, dataOffset + 30, 5, "4G 状态", fourGStatus.summary, { note: `8 条状态：${fourGStatus.history.join("；")}`, tone: "status" }),
        field(bytes, dataOffset + 35, 1, "RSSI", String(rssi), { tone: "status" }),
        field(bytes, dataOffset + 36, 1, "RSRQ", String(rsrq), { tone: "status" }),
        field(bytes, dataOffset + 37, 1, "RSRP", String(rsrp), { tone: "status" }),
      );
      const invalidFlows = [currentFlow, settlementFlow, reverseFlow].filter((item) => item.value === null);
      diagnostics.push(invalidFlows.length
        ? { level: "warn", text: `${invalidFlows.length} 个流量字段的 BCD 或单位码无法识别。` }
        : { level: "ok", text: "总累积量、结算日流量及反向流量均已完成 BCD 与单位换算。" });
      diagnostics.push(meterTime === "—" ? { level: "warn", text: "上报时间不是有效 BCD。" } : { level: "ok", text: "上报时间字段有效。" });
    } else {
      const remainingLength = Math.max(0, dataLength - 2);
      if (remainingLength) fields.push(field(bytes, dataOffset + 2, remainingLength, "DI 数据内容", hex(safeSlice(bytes, dataOffset + 2, remainingLength)), { note: DI_NAMES[di] ?? "原始数据", tone: "value" }));
      diagnostics.push({ level: DI_NAMES[di] ? "ok" : "warn", text: DI_NAMES[di] ? `${DI_NAMES[di]} 已识别，当前以原始字段展示。` : `未知数据标识 ${di}，已保留完整 DATA。` });
    }

    fields.push(
      field(bytes, checksumOffset, 1, "校验和 CS", hexByte(bytes[checksumOffset]), { note: "从 68 至 DATA 末字节累加取低 8 位", tone: "check" }),
      field(bytes, checksumOffset + 1, 1, "结束符", "16H", { tone: "header" }),
    );

    const overviewSections: ParseResult["overviewSections"] = [{
      id: "meter",
      title: "仪表与报文",
      items: [
        { key: "meterType", label: "仪表类型", value: `${type.label} · ${type.codeLabel}` },
        { key: "meterNo", label: "表号", value: meterAddress(bytes, start) },
        { key: "command", label: "报文用途", value: DI_NAMES[di] ?? di },
        { key: "dataLength", label: "长度", value: `${hexByte(dataLength)}H（${dataLength} Bytes）` },
        { key: "meterTime", label: "上报时间", value: meterTime },
      ],
    }];
    if (di === "9020") overviewSections.push(
      { id: "flow", title: "计量数据", items: [
        { key: "currentFlow", label: "总累积量", value: currentFlow?.value ?? null, unit: "m³", note: `原始值 ${hex(safeSlice(bytes, dataOffset + 3, 4)).replaceAll(" ", "")}` },
        { key: "settlementFlow", label: "结算日流量", value: settlementFlow?.value ?? null, unit: "m³", note: `原始值 ${hex(safeSlice(bytes, dataOffset + 8, 4)).replaceAll(" ", "")}` },
        { key: "reverseFlow", label: "反向流量", value: reverseFlow?.value ?? null, unit: "m³" },
      ] },
      { id: "status", title: "设备与网络状态", items: [
        { key: "valveStatus", label: "阀门状态", value: valveStatus },
        { key: "statusInfo", label: "设备状态", value: statusText },
        { key: "fourGModule", label: "4G 模组", value: fourGMode?.moduleName ?? "—", note: fourGMode ? `模式字 ${fourGMode.raw}，高 4 Bits=${fourGMode.moduleCode}` : undefined },
        { key: "reportReason", label: "上报类型", value: fourGMode?.reportReason ?? "—", note: fourGMode ? `低 4 Bits=${fourGMode.reportCode}` : undefined },
        { key: "fourGStatus", label: "4G 状态", value: fourGStatus?.latest ?? "—", note: fourGStatus ? `最近状态位于最高 4 Bits` : undefined },
        { key: "uploadCount", label: "模块上报总次数", value: fourGStatus?.uploadCount ?? null, unit: "次" },
        { key: "rssi", label: "RSSI", value: rssi },
        { key: "rsrq", label: "RSRQ", value: rsrq },
        { key: "rsrp", label: "RSRP", value: rsrp },
      ] },
    );

    return {
      protocol: `Joymeter · CJ/T 188 ${type.label}`,
      protocolId: this.id,
      category: "water",
      categoryLabel: "小口径水表协议",
      manufacturer: "Joymeter",
      confidence: this.detect(bytes),
      meterNo: meterAddress(bytes, start),
      controlCode: `${hexByte(bytes[controlOffset])}H`,
      dataIdentifier: di,
      dataLength,
      coreValue: currentFlow?.value == null ? (DI_NAMES[di] ?? "已识别报文") : `${formatNumber(currentFlow.value, 3)} m³`,
      metrics: {
        currentFlow: currentFlow?.value ?? null,
        settlementFlow: settlementFlow?.value ?? null,
        reverseFlow: reverseFlow?.value ?? null,
        meterTime,
        valveStatus,
        statusInfo: statusText,
        fourGMode: fourGMode?.summary ?? "—",
        fourGModule: fourGMode?.moduleName ?? "—",
        reportReason: fourGMode?.reportReason ?? "—",
        fourGStatus: fourGStatus?.latest ?? "—",
        fourGStatusHistory: fourGStatus?.history.join("；") ?? "—",
        uploadCount: fourGStatus?.uploadCount ?? null,
        rssi,
        rsrq,
        rsrp,
      },
      overviewSections,
      fields,
      diagnostics,
      history: [],
      rawBytes: bytes,
    };
  },
};
