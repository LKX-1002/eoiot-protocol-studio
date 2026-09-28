import { checksumDiagnostics, findFrameStart, hex, hexByte, safeSlice, uint } from "./bytes";
import { parseWotmanIpCommand } from "./wotman-command";
import { parseWotmanSyncCommand } from "./wotman-sync-command";
import { parseCollectionIntervalCommand, parseUploadScheduleCommand, parseValveCommand } from "./wotman-control-command";
import type { ParseResult, ProtocolParser } from "./types";

function commandKind(bytes: number[], start: number) {
  const di = hex(safeSlice(bytes, start + 12, 2)).replaceAll(" ", "");
  return di === "8110" ? "network"
    : di === "A016" ? "sync"
      : di === "A017" ? "valve"
        : di === "8104" ? "schedule"
          : di === "8105" ? "interval"
            : null;
}

/** 沃特曼平台下发帧：04H 控制码、2 字节小端长度、DI 位于偏移 12。 */
export const wotmanCommandParser: ProtocolParser = {
  id: "wotman-command",
  name: "沃特曼 · 下行写入指令",
  category: "water",
  status: "ready",

  detect(bytes) {
    const start = findFrameStart(bytes);
    if (start < 0 || bytes.length - start < 16 || bytes[start + 9] !== 0x04) return 0;
    const kind = commandKind(bytes, start);
    if (!kind) return 10;
    const declared = uint(safeSlice(bytes, start + 10, 2), "le");
    const actual = bytes.length - start - 14;
    return declared === actual ? 100 : 75;
  },

  validate(bytes) {
    const start = findFrameStart(bytes);
    const kind = commandKind(bytes, start);
    if (kind === "network") parseWotmanIpCommand(hex(bytes));
    else if (kind === "sync") parseWotmanSyncCommand(bytes);
    else if (kind === "valve") parseValveCommand(bytes);
    else if (kind === "schedule") parseUploadScheduleCommand(bytes);
    else if (kind === "interval") parseCollectionIntervalCommand(bytes);
    else throw new Error("数据标识错误：当前支持 8110H、A016H、A017H、8104H 与 8105H 写入指令。");
  },

  parse(bytes): ParseResult {
    const start = findFrameStart(bytes);
    const kind = commandKind(bytes, start);
    if (!kind) throw new Error("未识别的沃特曼写入指令。");
    const diagnostics = checksumDiagnostics(bytes, start);

    if (kind === "network") {
      const parsed = parseWotmanIpCommand(hex(bytes));
      diagnostics.push(
        { level: "ok", text: "控制码 04H、数据标识 8110H 与 59 Bytes 数据区一致。" },
        { level: "ok", text: "主用、备用、网关、代理、本地网络、APN、子网掩码及 MAC 字段已完整解析。" },
      );
      return {
        protocol: "沃特曼下行指令 · 写通信参数",
        protocolId: this.id,
        category: "water",
        categoryLabel: "沃特曼写入指令",
        manufacturer: "武汉沃特曼",
        confidence: this.detect(bytes),
        meterNo: parsed.meterAddress,
        controlCode: "04H",
        dataIdentifier: "8110",
        dataLength: 59,
        coreValue: `${parsed.primaryIp}:${parsed.primaryPort}`,
        metrics: { primaryIp: parsed.primaryIp, primaryPort: parsed.primaryPort, apn: parsed.apn },
        overviewSections: [
          { id: "command", title: "写入目标", items: [
            { key: "meterNo", label: "设备编号", value: parsed.meterAddress },
            { key: "primary", label: "主用服务器", value: `${parsed.primaryIp}:${parsed.primaryPort}` },
            { key: "apn", label: "APN", value: parsed.apn || "空" },
          ] },
          { id: "network", title: "备用与本地网络", items: [
            { key: "backup", label: "备用服务器", value: `${parsed.backupIp}:${parsed.backupPort}` },
            { key: "gateway", label: "网关服务器", value: `${parsed.gatewayIp}:${parsed.gatewayPort}` },
            { key: "proxy", label: "代理服务器", value: `${parsed.proxyIp}:${parsed.proxyPort}` },
            { key: "local", label: "本地服务器", value: `${parsed.localIp}:${parsed.localPort}` },
            { key: "mask", label: "子网掩码", value: parsed.subnetMask },
            { key: "mac", label: "MAC 地址", value: parsed.macAddress },
          ] },
        ],
        fields: parsed.fields,
        diagnostics,
        history: [],
        rawBytes: bytes,
      };
    }

    if (kind === "valve") {
      const parsed = parseValveCommand(bytes);
      diagnostics.push({ level: "ok", text: `阀门控制字有效，本次操作为${parsed.actionLabel}。` });
      return {
        protocol: "沃特曼下行指令 · 采集器阀门控制", protocolId: this.id, category: "water", categoryLabel: "沃特曼写入指令", manufacturer: "武汉沃特曼", confidence: this.detect(bytes),
        meterNo: parsed.meterAddress, controlCode: "04H", dataIdentifier: "A017", dataLength: 4, coreValue: parsed.actionLabel,
        metrics: { valveAction: parsed.actionLabel },
        overviewSections: [{ id: "command", title: "阀门控制", items: [
          { key: "meterNo", label: "设备编号", value: parsed.meterAddress },
          { key: "action", label: "执行操作", value: parsed.actionLabel },
          { key: "control", label: "控制字", value: parsed.action === "open" ? "55H" : "99H" },
        ] }], fields: parsed.fields, diagnostics, history: [], rawBytes: bytes,
      };
    }

    if (kind === "schedule") {
      const parsed = parseUploadScheduleCommand(bytes);
      const scheduleText = parsed.schedule.flatMap((pair, hour) => pair.flatMap((minute) => minute === null ? [] : [`${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`])).join("、");
      diagnostics.push({ level: "ok", text: `24 小时上传参数已解析，共启用 ${parsed.enabledCount} 个上传时刻。` });
      return {
        protocol: "沃特曼下行指令 · 自动上传时间", protocolId: this.id, category: "water", categoryLabel: "沃特曼写入指令", manufacturer: "武汉沃特曼", confidence: this.detect(bytes),
        meterNo: parsed.meterAddress, controlCode: "04H", dataIdentifier: "8104", dataLength: 51, coreValue: `${parsed.enabledCount} 个上传时刻`,
        metrics: { uploadTimeCount: parsed.enabledCount, uploadTimes: scheduleText || "全部停用" },
        overviewSections: [{ id: "command", title: "自动上传时间", items: [
          { key: "meterNo", label: "设备编号", value: parsed.meterAddress },
          { key: "count", label: "启用时刻", value: parsed.enabledCount, unit: "个" },
          { key: "times", label: "上传时间", value: scheduleText || "全部停用" },
        ] }], fields: parsed.fields, diagnostics, history: [], rawBytes: bytes,
      };
    }

    if (kind === "interval") {
      const parsed = parseCollectionIntervalCommand(bytes);
      diagnostics.push({ level: "ok", text: `数据采集间隔已解析为 ${parsed.intervalMinutes} 分钟。` });
      return {
        protocol: "沃特曼下行指令 · 数据采集间隔", protocolId: this.id, category: "water", categoryLabel: "沃特曼写入指令", manufacturer: "武汉沃特曼", confidence: this.detect(bytes),
        meterNo: parsed.meterAddress, controlCode: "04H", dataIdentifier: "8105", dataLength: 4, coreValue: `${parsed.intervalMinutes} 分钟`,
        metrics: { collectionInterval: parsed.intervalMinutes },
        overviewSections: [{ id: "command", title: "采集间隔", items: [
          { key: "meterNo", label: "设备编号", value: parsed.meterAddress },
          { key: "interval", label: "采集间隔", value: parsed.intervalMinutes, unit: "分钟" },
          { key: "raw", label: "原始值", value: `${hexByte(parsed.intervalMinutes)}H` },
        ] }], fields: parsed.fields, diagnostics, history: [], rawBytes: bytes,
      };
    }

    const parsed = parseWotmanSyncCommand(bytes);
    diagnostics.push(
      { level: "ok", text: "控制码 04H、数据标识 A016H 与 8 Bytes 数据区一致。" },
      { level: "ok", text: "累计量已按 4 字节小端 BCD 与 2CH 单位换算为 m³。" },
    );
    return {
      protocol: "沃特曼下行指令 · 写机电同步",
      protocolId: this.id,
      category: "water",
      categoryLabel: "沃特曼写入指令",
      manufacturer: "武汉沃特曼",
      confidence: this.detect(bytes),
      meterNo: parsed.meterAddress,
      controlCode: "04H",
      dataIdentifier: "A016",
      dataLength: 8,
      coreValue: `${parsed.cumulativeFlow.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} m³`,
      metrics: { currentFlow: parsed.cumulativeFlow, unitCode: parsed.unitCode },
      overviewSections: [
        { id: "command", title: "写入目标", items: [
          { key: "meterNo", label: "设备编号", value: parsed.meterAddress },
          { key: "command", label: "指令用途", value: "写机电同步" },
          { key: "flow", label: "当前累计流量", value: parsed.cumulativeFlow, unit: "m³", note: "2CH：精度 0.01 m³" },
        ] },
      ],
      fields: parsed.fields,
      diagnostics,
      history: [],
      rawBytes: bytes,
    };
  },
};
