import {
  bcdLittleEndian,
  field,
  findFrameStart,
  hex,
  hexByte,
  validateFrameEnvelope,
} from "./bytes";
import type { Diagnostic, OverviewItem, ParsedField, ProtocolParser } from "./types";
import { describeDlt645Energy } from "./dlt645-capabilities";

/** 已确认设备的费率 1–4 对应尖峰平谷；其他设备应核对表内费率配置。 */
const rates = ["累计用量", "尖", "峰", "平", "谷"];
const keys = ["totalEnergy", "tipEnergy", "peakEnergy", "flatEnergy", "valleyEnergy"];
const decode = (bytes: number[]) => bytes.map((value) => (value - 0x33 + 256) & 0xff);
const compact = (bytes: number[]) => bytes.map(hexByte).join("");

function envelope(bytes: number[]) {
  const start = findFrameStart(bytes);
  if (start < 0 || bytes[start + 7] !== 0x68)
    throw new Error("DL/T 645 帧结构错误：地址后必须为第二个 68H。");
  validateFrameEnvelope(bytes, start);
  const length = bytes[start + 9];
  if (bytes.length !== start + 12 + length)
    throw new Error(
      `DL/T 645 长度错误：数据域声明 ${length} Bytes，整帧应为 ${start + 12 + length} Bytes。`,
    );
  if (!/^\d{12}$/.test(compact(bytes.slice(start + 1, start + 7))))
    throw new Error("电表地址不是有效的 6 字节 BCD。");
  const control = bytes[start + 8];
  if (control !== 0x11 && control !== 0x91)
    throw new Error(`暂不支持 DL/T 645 控制码 ${hexByte(control)}H，仅支持完整读数据请求和应答。`);
  if (length < 4) throw new Error("DL/T 645 数据域不足 4 字节，缺少数据标识。");
  const data = decode(bytes.slice(start + 10, start + 10 + length));
  const di = compact(data.slice(0, 4).reverse());
  return { start, length, control, data, di };
}

export const dlt645Parser: ProtocolParser = {
  id: "dlt645-energy",
  name: "DL/T 645-2007 · 单费率 / 多费率电表",
  category: "electric",
  status: "ready",
  detect(bytes) {
    const start = findFrameStart(bytes);
    return start >= 0 && bytes[start + 7] === 0x68 && [0x11, 0x91].includes(bytes[start + 8])
      ? 100
      : 0;
  },
  validate(bytes) {
    const { length, control, data, di } = envelope(bytes);
    if (control === 0x11) {
      if (length !== 4) throw new Error("DL/T 645 普通读数据请求的数据域须为 4 字节 DI。");
      return;
    }
    const info = describeDlt645Energy(di);
    if (!info)
      throw new Error(
        `暂不支持电表应答 DI ${di}：支持当前组合、正向、反向有功的总量、费率 1–8 及全部费率数据块；自定义 DI 仅生成和识别请求。`,
      );
    if (info.block ? length < 8 || length > 40 || (length - 4) % 4 !== 0 : length !== 8)
      throw new Error(
        `电表 ${di} 数据长度无效：单项电量应为 8 Bytes，数据块为 DI 加 1–9 个四字节电量值。`,
      );
    if (
      data.slice(4).some((value, index) => {
        const digit = info.kind === "00" && index % 4 === 3 ? value & 0x7f : value;
        return (digit & 15) > 9 || digit >> 4 > 9;
      })
    )
      throw new Error("电量 BCD 编码无效：数据域减 33H 后包含非十进制数字。");
  },
  parse(bytes) {
    this.validate(bytes);
    const { start, length, control, data, di } = envelope(bytes);
    const request = control === 0x11;
    const info = describeDlt645Energy(di);
    const block = info?.block ?? false;
    const energyType = info?.energyType ?? "自定义数据项";
    const rate = info?.rate ?? 0;
    const mode = info
      ? block
        ? "多费率电量"
        : rate === 0
          ? "累计电量"
          : `费率 ${rate} 电量`
      : "自定义读数据";
    const meterNo = compact(bytes.slice(start + 1, start + 7).reverse());
    const checksumOffset = start + 10 + length;
    const metrics: Record<string, string | number | null> = { energyType, readingMode: mode };
    const items: OverviewItem[] = [];
    const fields: ParsedField[] = [
      ...(start
        ? [
            field(bytes, 0, start, "唤醒字节", `${start} 个 FE`, {
              note: "不参与 CS 计算",
              tone: "meta",
            }),
          ]
        : []),
      field(bytes, start, 1, "起始符", "68H", { tone: "header" }),
      field(bytes, start + 1, 6, "电表地址", meterNo, {
        note: "6 字节 BCD，低字节在前",
        tone: "meta",
      }),
      field(bytes, start + 7, 1, "第二起始符", "68H", { tone: "header" }),
      field(bytes, start + 8, 1, "控制码", request ? "11H · 读数据请求" : "91H · 读数据应答", {
        tone: "header",
      }),
      field(bytes, start + 9, 1, "数据域长度", `${length} Bytes`, { tone: "meta" }),
      field(bytes, start + 10, 4, "数据标识 DI", di, {
        note: `逐字节减 33H 后反转：${energyType}${mode}`,
        tone: "meta",
      }),
    ];
    if (!request)
      for (let index = 0; index < (length - 4) / 4; index++) {
        const valueBytes = data.slice(4 + index * 4, 8 + index * 4);
        const negative = info?.kind === "00" && (valueBytes[3] & 0x80) !== 0;
        if (info?.kind === "00") valueBytes[3] &= 0x7f;
        const value = bcdLittleEndian(valueBytes, 2)! * (negative ? -1 : 1);
        const itemRate = block ? index : rate;
        const key = keys[itemRate] ?? `rate${itemRate}Energy`;
        metrics[key] = value;
        if (!block) metrics.readingEnergy = value;
        const label =
          itemRate === 0
            ? rates[0]
            : itemRate <= 4
              ? `${rates[itemRate]}电量`
              : `费率 ${itemRate} 电量`;
        const note = `解码后 ${hex(data.slice(4 + index * 4, 8 + index * 4))}；BCD 低字节在前，2 位小数`;
        fields.push(
          field(bytes, start + 14 + index * 4, 4, label, value.toFixed(2), {
            unit: "kWh",
            note,
            tone: "value",
          }),
        );
        items.push({ key, label, value, unit: "kWh" });
      }
    fields.push(
      field(bytes, checksumOffset, 1, "校验和 CS", hexByte(bytes[checksumOffset]), {
        note: "从第一个 68H 至数据域末尾累加取低 8 位",
        tone: "check",
      }),
      field(bytes, checksumOffset + 1, 1, "结束符", "16H", { tone: "header" }),
    );
    const diagnostics: Diagnostic[] = [
      { level: "ok", text: "帧结构、数据长度、BCD 与 CS 校验通过。" },
    ];
    if (block && !request && (length - 4) / 4 > 1) {
      const sum = items.slice(1).reduce((total, item) => total + Number(item.value), 0);
      const difference = Math.round((Number(metrics.totalEnergy) - sum) * 100) / 100;
      metrics.tariffSum = Math.round(sum * 100) / 100;
      metrics.tariffDifference = difference;
      diagnostics.push({
        level: difference === 0 ? "ok" : "warn",
        text:
          difference === 0
            ? "返回的各费率合计与累计用量一致。"
            : `累计用量与返回费率合计相差 ${difference.toFixed(2)} kWh，请核对表内费率配置。`,
      });
    }
    return {
      protocol: `DL/T 645-2007 · ${mode}${request ? "请求" : "应答"}`,
      protocolId: this.id,
      category: "electric",
      categoryLabel: "单费率 / 多费率电表",
      manufacturer: "DL/T 645",
      confidence: 100,
      meterNo,
      controlCode: `${hexByte(control)}H`,
      dataIdentifier: di,
      dataLength: length,
      coreValue: request
        ? "读数据请求"
        : `${Number(block ? metrics.totalEnergy : metrics.readingEnergy).toFixed(2)} kWh`,
      metrics: { ...metrics, rate: block ? null : rate },
      fields,
      diagnostics,
      history: [],
      rawBytes: bytes,
      overviewSections: [
        {
          id: "meter",
          title: "电表与报文",
          items: [
            { key: "meterNo", label: "表号", value: meterNo },
            { key: "energyType", label: "电能类型", value: energyType },
            { key: "readingMode", label: "数据内容", value: mode },
            { key: "direction", label: "报文用途", value: request ? "读数据请求" : "读数据应答" },
          ],
        },
        ...(!request ? [{ id: "energy", title: "电量数据", items }] : []),
      ],
    };
  },
};
