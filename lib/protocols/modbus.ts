import { field, hex, hexByte, uint } from "./bytes";
import type {
  Diagnostic,
  ModbusDecodeConfig,
  OverviewItem,
  ParsedField,
  ParseOptions,
  ProtocolParser,
} from "./types";

/** CRC16/Modbus；传输时低字节在前。 */
export function modbusCrc16(bytes: number[]): number {
  let crc = 0xffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

const EXCEPTIONS: Record<number, string> = {
  1: "非法功能",
  2: "非法数据地址",
  3: "非法数据值",
  4: "从站设备故障",
  5: "确认，正在处理",
  6: "从站设备忙",
  8: "存储奇偶校验错误",
  10: "网关路径不可用",
  11: "网关目标设备未响应",
};
const WIDTHS: Record<string, number> = { UINT16: 1, INT16: 1, UINT32: 2, INT32: 2, FLOAT32: 2 };
const ORDERS: Record<string, number[]> = {
  AB: [0, 1],
  BA: [1, 0],
  ABCD: [0, 1, 2, 3],
  CDAB: [2, 3, 0, 1],
  BADC: [1, 0, 3, 2],
  DCBA: [3, 2, 1, 0],
};

/** 构造 03/04 读取请求，地址为线上协议地址（从 0 计），CRC 低字节先发。 */
export function buildModbusReadRequest(
  slave: number,
  functionCode: number,
  address: number,
  quantity: number,
): number[] {
  if (!Number.isInteger(slave) || slave < 1 || slave > 247)
    throw new Error("从站地址必须为 1–247 的整数。");
  if (![3, 4].includes(functionCode)) throw new Error("读取功能码仅支持 03 或 04。");
  if (!Number.isInteger(address) || address < 0 || address > 65535)
    throw new Error("起始地址必须为 0–65535 的整数。");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 125 || address + quantity > 65536)
    throw new Error("寄存器数量必须为 1–125，且读取范围不能超过 65535。");
  const bytes = [slave, functionCode, address >>> 8, address & 255, quantity >>> 8, quantity & 255];
  const crc = modbusCrc16(bytes);
  return [...bytes, crc & 255, crc >>> 8];
}

export function formatModbusValue(value: number, decimals?: number): string {
  return decimals === undefined
    ? Number(value.toPrecision(12)).toString()
    : value.toFixed(decimals);
}

function decodeConfig(options: ParseOptions): ModbusDecodeConfig | undefined {
  // 兼容改版前本机历史中保存的规则；新界面只使用显式配置。
  return (
    options.modbusDecode ??
    (options.modbusProfile === "uint16-energy"
      ? {
          dataType: "UINT16",
          byteOrder: "AB",
          scale: 0.01,
          unit: "kWh",
          registerOffset: 0,
          valueCount: 1,
          label: "累计电量",
          decimals: 2,
        }
      : undefined)
  );
}

function validateConfig(config: ModbusDecodeConfig, available?: number): number {
  if (config.rangeMode !== undefined && !["all", "custom"].includes(config.rangeMode))
    throw new Error("解析范围模式无效。");
  const width = WIDTHS[config.dataType];
  if (!width) throw new Error("请选择支持的数据类型：UINT16、INT16、UINT32、INT32 或 FLOAT32。");
  if (!ORDERS[config.byteOrder] || ORDERS[config.byteOrder].length !== width * 2)
    throw new Error(
      width === 1
        ? "16 位数据请选择 AB 或 BA 字节序。"
        : "32 位数据请选择 ABCD、CDAB、BADC 或 DCBA 字节序。",
    );
  if (!Number.isFinite(config.scale))
    throw new Error("缩放因子必须是有效有限数值，例如 1、0.01 或 1000。");
  if (!Number.isInteger(config.registerOffset) || config.registerOffset < 0)
    throw new Error("起始位置必须是从 0 开始的非负整数。");
  if (!Number.isInteger(config.valueCount) || config.valueCount < 1 || config.valueCount > 125)
    throw new Error("解析数量必须是 1–125 的整数。");
  if (
    config.decimals !== undefined &&
    (!Number.isInteger(config.decimals) || config.decimals < 0 || config.decimals > 8)
  )
    throw new Error("显示小数位必须为 0–8，或选择自动。");
  if (
    typeof config.unit !== "string" ||
    config.unit.length > 24 ||
    typeof config.label !== "string" ||
    config.label.length > 40
  )
    throw new Error("单位最多 24 个字符，数据名称最多 40 个字符。");
  if (config.model !== undefined && (typeof config.model !== "string" || config.model.length > 40))
    throw new Error("型号最多 40 个字符。");
  if (
    config.registerAddress !== undefined &&
    (!Number.isInteger(config.registerAddress) ||
      config.registerAddress < 0 ||
      config.registerAddress > 65535 ||
      config.registerAddress + config.registerOffset + width * config.valueCount > 65536)
  )
    throw new Error("协议地址及所选数据范围必须位于 0–65535 内。");
  if (available !== undefined && config.registerOffset + width * config.valueCount > available)
    throw new Error(
      `数据不足：从第 ${config.registerOffset} 个寄存器起，${config.valueCount} 组 ${config.dataType} 需要 ${width * config.valueCount} 个寄存器；应答共 ${available} 个。`,
    );
  return width;
}

function decodeNumber(raw: number[], config: ModbusDecodeConfig): number {
  const reordered = ORDERS[config.byteOrder].map((index) => raw[index]);
  const view = new DataView(Uint8Array.from(reordered).buffer);
  const value =
    config.dataType === "UINT16"
      ? view.getUint16(0)
      : config.dataType === "INT16"
        ? view.getInt16(0)
        : config.dataType === "UINT32"
          ? view.getUint32(0)
          : config.dataType === "INT32"
            ? view.getInt32(0)
            : view.getFloat32(0);
  if (!Number.isFinite(value))
    throw new Error(
      `数据 ${hex(raw)} 按 ${config.dataType}/${config.byteOrder} 解析为 NaN 或 Infinity，请核对类型或字节序。`,
    );
  return value;
}

export const modbusParser: ProtocolParser = {
  id: "modbus-rtu",
  name: "Modbus RTU · 自定义寄存器解析",
  category: "industrial",
  status: "ready",
  detect(bytes) {
    return bytes[0] >= 1 && bytes[0] <= 247 && [3, 4, 0x83, 0x84].includes(bytes[1]) ? 100 : 0;
  },
  validate(bytes) {
    if (bytes.length < 5) throw new Error("Modbus RTU 帧不足 5 字节。");
    if (bytes[0] < 1 || bytes[0] > 247) throw new Error("Modbus 从站地址应为 1–247。");
    if (![3, 4, 0x83, 0x84].includes(bytes[1]))
      throw new Error("当前支持 Modbus 03H/04H 读取请求、正常应答及 83H/84H 异常应答。");
    const expected = modbusCrc16(bytes.slice(0, -2));
    if (uint(bytes.slice(-2), "le") !== expected)
      throw new Error(
        `Modbus CRC 错误：应为 ${hex([expected & 255, expected >>> 8])}（低字节在前）。`,
      );
    if (bytes[1] & 0x80) {
      if (bytes.length !== 5) throw new Error("Modbus 异常应答应为 5 字节。");
    } else if (bytes.length === 8) {
      const count = uint(bytes.slice(4, 6));
      if (!count || count > 125 || uint(bytes.slice(2, 4)) + count > 65536)
        throw new Error("Modbus 请求的寄存器数量或地址范围无效。");
    } else if (!bytes[2] || bytes[2] > 250 || bytes[2] % 2 !== 0 || bytes.length !== bytes[2] + 5) {
      throw new Error(
        "Modbus 应答长度错误：数据字节数应为 2–250 的偶数，整帧长度 = 数据字节数 + 5。",
      );
    }
  },
  parse(bytes, options = {}) {
    this.validate(bytes);
    const exception = (bytes[1] & 0x80) !== 0;
    const request = !exception && bytes.length === 8;
    const start = request ? uint(bytes.slice(2, 4)) : null;
    const count = request ? uint(bytes.slice(4, 6)) : exception ? 0 : bytes[2] / 2;
    const response = !request && !exception;
    const requestedConfig = decodeConfig(options);
    let config = requestedConfig;
    if (response && requestedConfig?.rangeMode === "all") {
      const width = WIDTHS[requestedConfig.dataType];
      if (!width) throw new Error("请选择支持的数据类型。");
      if (count % width !== 0)
        throw new Error(
          `数据区共 ${bytes[2]} 字节，不能按 ${requestedConfig.dataType}（每个数 ${width * 2} 字节）完整解析。请检查数据类型，或启用自定义解析范围。`,
        );
      config = { ...requestedConfig, registerOffset: 0, valueCount: count / width };
    }
    const width = config && !exception ? validateConfig(config, response ? count : undefined) : 0;
    if (request && config?.registerAddress !== undefined && config.registerAddress !== start)
      throw new Error("配置地址与请求帧中的起始地址不一致，请以请求帧为准。");
    const purpose = exception ? "异常应答" : request ? "读取请求" : "读取应答";
    const errorText = exception
      ? (EXCEPTIONS[bytes[2]] ?? `未定义异常码 ${hexByte(bytes[2])}H`)
      : "";
    const label = config?.label.trim() || "解析值";
    const unit = config?.unit.trim() || "";
    const decimals = config?.decimals;
    const rule = config
      ? `${config.dataType} · ${config.byteOrder} · × ${config.scale}${unit ? " " + unit : ""}`
      : "仅查看原始寄存器";
    const diagnostics: Diagnostic[] = [
      { level: "ok", text: "Modbus RTU 帧长度与 CRC16 校验通过。" },
    ];
    if (exception)
      diagnostics.push({ level: "bad", text: `${hexByte(bytes[2])}H：${errorText}。` });
    if (request && config && config.registerOffset + width * config.valueCount > count)
      diagnostics.push({
        level: "warn",
        text: `解析配置需要 ${config.registerOffset + width * config.valueCount} 个寄存器，但当前请求只读取 ${count} 个；请核对后续请求和配置。`,
      });
    // 应答并未携带地址，属于协议结构，不将正常报文误标为设备告警。
    if (response)
      diagnostics.push({
        level: "ok",
        text: config
          ? `按所选规则 ${rule} 解析；应答无寄存器地址，起始位置为应答数据区内的相对位置。`
          : "按高字节在前显示原始 16 位寄存器，未推断业务类型、倍率或单位。",
      });
    const fields: ParsedField[] = [
      field(bytes, 0, 1, "从站地址", String(bytes[0]), {
        note: "设备通信地址，不是电表出厂表号",
        tone: "meta",
      }),
      field(bytes, 1, 1, "功能码", `${hexByte(bytes[1])}H · ${purpose}`, { tone: "header" }),
    ];
    const decoded: Array<{
      raw: number;
      value: number;
      offset: number;
      label: string;
      note: string;
    }> = [];
    if (request)
      fields.push(
        field(
          bytes,
          2,
          2,
          "起始寄存器地址",
          `${start} / ${start!.toString(16).padStart(4, "0").toUpperCase()}H`,
          { note: "协议原始地址；高字节在前", tone: "meta" },
        ),
        field(bytes, 4, 2, "寄存器数量", String(count), { tone: "meta" }),
      );
    else if (exception) fields.push(field(bytes, 2, 1, "异常码", errorText, { tone: "status" }));
    else {
      fields.push(field(bytes, 2, 1, "数据字节数", `${bytes[2]} Bytes`, { tone: "meta" }));
      for (let i = 0; i < count;) {
        const offset = 3 + 2 * i;
        if (
          config &&
          i >= config.registerOffset &&
          i < config.registerOffset + width * config.valueCount
        ) {
          const raw = decodeNumber(bytes.slice(offset, offset + width * 2), config);
          const value = raw * config.scale;
          if (!Number.isFinite(value))
            throw new Error("缩放后的数值超出有限数值范围，请调整缩放因子。");
          const name = config.valueCount === 1 ? label : `${label} ${decoded.length + 1}`;
          const note = `${config.dataType} / ${config.byteOrder}：${formatModbusValue(raw)} × ${config.scale} = ${formatModbusValue(value, decimals)}${unit ? " " + unit : ""}；应答内寄存器位置 ${i}${config.registerAddress === undefined ? "" : `；配置地址 ${(config.registerAddress + i).toString(16).padStart(4, "0").toUpperCase()}H`}`;
          fields.push(
            field(bytes, offset, width * 2, name, formatModbusValue(value, decimals), {
              ...(unit ? { unit } : {}),
              note,
              tone: "value",
            }),
          );
          decoded.push({ raw, value, offset: i, label: name, note });
          i += width;
        } else {
          fields.push(
            field(
              bytes,
              offset,
              2,
              `原始寄存器 [${i}]`,
              String(uint(bytes.slice(offset, offset + 2))),
              {
                note: "UINT16 高字节在前；未应用缩放或业务单位；方括号为应答数据区内位置",
                tone: "meta",
              },
            ),
          );
          i++;
        }
      }
    }
    fields.push(
      field(bytes, bytes.length - 2, 2, "校验码 CRC16", hex(bytes.slice(-2)), {
        note: "多项式 A001H，初始值 FFFFH，低字节在前",
        tone: "check",
      }),
    );
    const first = decoded[0];
    const configuredAddress = config?.registerAddress;
    const parameterItems: OverviewItem[] = [
      { key: "purpose", label: "报文用途", value: purpose },
      { key: "count", label: "应答 / 请求寄存器数", value: count },
      {
        key: "start",
        label: "协议起始地址",
        value:
          start === null
            ? null
            : `${start} / ${start.toString(16).padStart(4, "0").toUpperCase()}H`,
      },
      { key: "rule", label: "解码规则", value: rule },
      { key: "position", label: "应答内起始位置", value: config ? config.registerOffset : null },
      { key: "valueCount", label: "配置解析数量", value: config ? config.valueCount : null },
      { key: "model", label: "型号", value: config?.model?.trim() || null },
      { key: "dataName", label: "数据名称", value: config ? label : null },
      {
        key: "configuredAddress",
        label: "配置起始地址（非应答字段）",
        value:
          configuredAddress === undefined
            ? null
            : `${configuredAddress} / ${configuredAddress.toString(16).padStart(4, "0").toUpperCase()}H`,
      },
    ];
    return {
      protocol: `Modbus RTU · ${purpose}`,
      protocolId: this.id,
      category: "industrial",
      categoryLabel: "通用设备 / 寄存器解析",
      manufacturer: "Modbus",
      confidence: 100,
      meterNo: String(bytes[0]),
      controlCode: `${hexByte(bytes[1])}H`,
      dataIdentifier: request
        ? `${start!.toString(16).padStart(4, "0").toUpperCase()}H`
        : configuredAddress === undefined
          ? "应答无地址"
          : `${configuredAddress.toString(16).padStart(4, "0").toUpperCase()}H（配置）`,
      dataLength: bytes.length - 4,
      coreValue: exception
        ? errorText
        : request
          ? "读取寄存器请求"
          : first && decoded.length === 1
            ? `${formatModbusValue(first.value, decimals)}${unit ? " " + unit : ""}`
            : decoded.length
              ? `${decoded.length} 组解析结果`
              : `${count} 个原始寄存器`,
      metrics: {
        decodedValue: first?.value ?? null,
        rawValue: first?.raw ?? null,
        label: first ? first.label : "报文内容",
        unit,
        model: config?.model?.trim() || "",
        configuredAddress: configuredAddress ?? null,
        registerStart: start,
        registerCount: count,
        scale: config?.scale ?? null,
        dataType: config?.dataType ?? "原始寄存器",
        byteOrder: config?.byteOrder ?? "AB",
        purpose,
        exceptionCode: exception ? bytes[2] : null,
        profileName: rule,
        decodeConfig: config ? JSON.stringify(config) : null,
        decodedCount: decoded.length,
      },
      fields,
      diagnostics,
      history: [],
      rawBytes: bytes,
      overviewSections: [
        ...(decoded.length
          ? [
              {
                id: "modbus-values",
                title: "数值换算",
                items: decoded.map((item, index) => ({
                  key: `value-${index}`,
                  label: item.label,
                  value: formatModbusValue(item.value, decimals),
                  ...(unit ? { unit } : {}),
                  note: item.note,
                })),
              },
            ]
          : []),
        { id: "modbus", title: "Modbus 报文与规则", items: parameterItems },
      ],
    };
  },
};
