import { checksumDiagnostics, findFrameStart } from "./bytes";
import { joymeterDefinition, parseJoymeterCommand } from "./joymeter-command";
import type { ParseResult, ProtocolParser } from "./types";

export const joymeterCommandParser: ProtocolParser = {
  id: "joymeter-command",
  name: "Joymeter 4G · 写入指令",
  category: "water",
  status: "ready",

  detect(bytes) {
    const start = findFrameStart(bytes);
    if (start < 0 || bytes.length - start < 16 || bytes[start + 1] !== 0x10) return 0;
    if (bytes[start + 9] !== 0x24 && bytes[start + 9] !== 0xa4) return 0;
    const first = bytes[start + 11];
    const second = bytes[start + 12];
    const supported = (first === 0xa1 && [0x71, 0x80, 0x81, 0x82, 0x83, 0x84].includes(second)) || (first === 0xa0 && second === 0x17);
    if (!supported) return 20;
    const declared = bytes[start + 10];
    const actual = bytes.length - start - 13;
    return declared === actual ? 100 : 75;
  },

  validate(bytes) {
    parseJoymeterCommand(bytes);
  },

  parse(bytes): ParseResult {
    const parsed = parseJoymeterCommand(bytes);
    const definition = joymeterDefinition(parsed.kind);
    const diagnostics = checksumDiagnostics(bytes, findFrameStart(bytes));
    diagnostics.push(
      { level: "ok", text: `控制码 ${parsed.controlCode}H、数据标识 ${parsed.dataIdentifier}H 与数据域长度一致。` },
      { level: "ok", text: parsed.direction === "request" ? "Joymeter 下行写入参数已完整反向解析。" : "Joymeter A4H 写入应答已识别。" },
    );

    const items = [
      { key: "meterNo", label: "设备编号", value: parsed.meterAddress },
      { key: "operation", label: "操作类型", value: definition.name },
      { key: "direction", label: "报文方向", value: parsed.direction === "request" ? "平台下发" : "水表应答" },
      ...Object.entries(parsed.metrics).map(([key, value]) => ({ key, label: ({ protocol: "通信协议", ip: "服务器 IP", port: "服务器端口", baseReading: "基表读数", valveAction: "阀门操作", startHour: "上报起始时间", maxRandomSeconds: "最大随机间隔", reportPeriodHours: "上报周期", status: "执行状态" } as Record<string, string>)[key] ?? key, value })),
    ];

    return {
      protocol: `Joymeter 4G 写入指令 · ${definition.name}`,
      protocolId: this.id,
      category: "water",
      categoryLabel: "Joymeter 4G 写入指令",
      manufacturer: "Joymeter",
      confidence: this.detect(bytes),
      meterNo: parsed.meterAddress,
      controlCode: `${parsed.controlCode}H`,
      dataIdentifier: parsed.dataIdentifier,
      dataLength: bytes[findFrameStart(bytes) + 10],
      coreValue: parsed.summary,
      metrics: parsed.metrics,
      overviewSections: [{ id: "command", title: parsed.direction === "request" ? "写入目标" : "执行应答", items }],
      fields: parsed.fields,
      diagnostics,
      history: [],
      rawBytes: bytes,
    };
  },
};
