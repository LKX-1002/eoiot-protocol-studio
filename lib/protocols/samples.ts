import { hex } from "./bytes";
import { modbusCrc16 } from "./modbus";

function withModbusChecksum(bytes: number[]) {
  const crc = modbusCrc16(bytes);
  return [...bytes, crc & 255, crc >>> 8];
}

/** 为示例帧计算从 68 开始的累加和，并补齐 CS 与结束符 16。 */
function withChecksum(frameWithoutChecksum: number[]) {
  const start = frameWithoutChecksum.indexOf(0x68);
  const checksum = frameWithoutChecksum
    .slice(start)
    .reduce((sum, value) => (sum + value) & 0xff, 0);
  return [...frameWithoutChecksum, checksum, 0x16];
}

/**
 * 样例用于回归已接入的水表、电表协议；真实帧与构造样例由名称和说明区分。
 * 9020、9023、9025 使用用户提供的真实帧；HTML 末尾空格标记不属于报文，未写入样例值。
 */
export const samples = {
  modbusEnergyRequest: {
    id: "modbus-uint16-request",
    name: "Modbus 读取累计电量请求",
    protocolId: "modbus-rtu",
    description: "从站 1，功能码 03，协议地址 0029H（十进制 41），读取 1 个寄存器。",
    value: "01 03 00 29 00 01 55 C2",
    modbusDecode: {
      dataType: "UINT16" as const,
      byteOrder: "AB" as const,
      scale: 0.01,
      unit: "kWh",
      registerOffset: 0,
      valueCount: 1,
      label: "累计电量",
      decimals: 2,
    },
  },
  modbusEnergyResponse: {
    id: "modbus-uint16-response",
    name: "Modbus 累计电量应答（11.42 kWh）",
    protocolId: "modbus-rtu",
    description: "预期应答样例。载入时填入 UINT16、AB、×0.01、kWh：0476H = 1142 → 11.42 kWh。",
    value: "01 03 02 04 76 3B 62",
    modbusDecode: {
      dataType: "UINT16" as const,
      byteOrder: "AB" as const,
      scale: 0.01,
      unit: "kWh",
      registerOffset: 0,
      valueCount: 1,
      label: "累计电量",
      decimals: 2,
    },
  },
  modbusFloatResponse: {
    id: "modbus-float32-response",
    name: "Modbus FLOAT32 电量应答（720.12 kWh）",
    protocolId: "modbus-rtu",
    description:
      "根据此前寄存器值构造的应答样例。FLOAT32、ABCD、×1、kWh；原始浮点数约 720.119995，显示为 720.12。",
    value: hex(withModbusChecksum([2, 3, 4, 0x44, 0x34, 0x07, 0xae])),
    modbusDecode: {
      dataType: "FLOAT32" as const,
      byteOrder: "ABCD" as const,
      scale: 1,
      unit: "kWh",
      registerOffset: 0,
      valueCount: 1,
      label: "累计电量",
      decimals: 2,
    },
  },
  electricSingle: {
    id: "dlt645-single-energy",
    name: "电表累计电量应答（模拟样例）",
    protocolId: "dlt645-energy",
    description: "DL/T 645-2007 正向有功累计电量 1234.56 kWh；仅返回累计量，不含分费率数据。",
    value: hex(
      withChecksum([
        0xfe, 0xfe, 0x68, 0x13, 0x79, 0x02, 0x00, 0x03, 0x48, 0x68, 0x91, 0x08, 0x33, 0x33, 0x34,
        0x33, 0x89, 0x67, 0x45, 0x33,
      ]),
    ),
  },
  electricMulti: {
    id: "dlt645-multi-energy",
    name: "电表多费率电量应答（模拟样例）",
    protocolId: "dlt645-energy",
    description:
      "沿用此前 CSV 的 0000FF00 数据块：累计 1000.00、尖 100.00、峰 200.00、平 300.00、谷 400.00 kWh。",
    value: hex(
      withChecksum([
        0xfe, 0xfe, 0x68, 0x13, 0x79, 0x02, 0x00, 0x03, 0x48, 0x68, 0x91, 0x18, 0x33, 0x32, 0x33,
        0x33, 0x33, 0x33, 0x43, 0x33, 0x33, 0x33, 0x34, 0x33, 0x33, 0x33, 0x35, 0x33, 0x33, 0x33,
        0x36, 0x33, 0x33, 0x33, 0x37, 0x33,
      ]),
    ),
  },
  joymeterMbus: {
    id: "joymeter-mbus-901f-report",
    name: "小口径水表 · MBus 901F 抄表应答",
    protocolId: "joymeter-mbus",
    description: "MBus 小口径水表应答，包含当前累计量、结算日累计量、表时间及两字节状态字。",
    value:
      "FE FE 68 10 46 01 43 00 05 51 00 81 16 90 1F 00 55 08 02 00 29 22 08 01 00 29 FF FF FF FF FF FF FF 04 00 77 16",
  },
  cjt188: {
    id: "joymeter-9020-report",
    name: "小口径水表 · 4G 9020 主动上报",
    protocolId: "cjt188-small",
    description: "小口径水表主动上报，包含计量、时间、状态及 4G 网络信息。",
    value:
      "FE FE 68 10 46 43 47 00 05 51 00 81 26 90 20 00 56 11 00 00 29 95 01 00 00 29 46 00 03 31 08 26 20 00 00 00 00 00 00 00 00 29 30 FF FF FF FF 5C 0A 0F 14 EA 16",
  },
  joymeterNetwork: {
    id: "joymeter-a184-network",
    name: "小口径水表 · 4G 写服务器 IP / 端口",
    protocolId: "joymeter-command",
    description: "A184H 下行写入帧：UDP、60.205.218.69、端口 6118。",
    value: "FE FE 68 10 54 89 08 00 05 51 00 24 0A A1 84 00 01 3C CD DA 45 E6 17 2C 16",
  },
  joymeterBase: {
    id: "joymeter-a171-base",
    name: "小口径水表 · 4G 写基表读数",
    protocolId: "joymeter-command",
    description: "A171H 下行写入帧：将基表读数写为 12345678 L。",
    value: "FE FE 68 10 54 89 08 00 05 51 00 24 08 A1 71 00 78 56 34 12 00 05 16",
  },
  wotman9021: {
    id: "wotman-9021-history",
    name: "大口径水表 · 4G 9021 历史数据",
    protocolId: "wotman-big",
    description: "9021 大口径水表历史累计量报文；当前暂用项目原有校验样例。",
    value: hex(withChecksum(createWotman9021())),
  },
  wotman9023: {
    id: "wotman-9023-history",
    name: "大口径水表 · 4G 9023 历史数据",
    protocolId: "wotman-big",
    description: "9023 大口径水表上报，包含多条五字节历史累计量及设备状态。",
    // 帧头声明 24 条历史值；相同的第 25 组是历史区之后的“当前累计流量”。
    value: [
      "68107555000005430081C20090230F010001001800033008263C",
      "0042000000".repeat(25),
      "FFFF8700840000660330000000000000000000086241507849339904600492790304340D00010014050231082620000200000029690503D416",
    ].join(""),
  },
  wotman9025: {
    id: "wotman-9025-history",
    name: "大口径水表 · 4G 9025 水表上报",
    protocolId: "wotman-big",
    description: "9025 大口径水表主动上报，历史记录按 A、B、C、D 四项解析。",
    value:
      "68106455000005430081260190251A020002000C00193008263C22111150000000000000000000000000000000005000000000000000000000000000000000500000000000000000000000000000000050000000000000000000000000000000005000000000000000000000000000000000500000000000000000000000000000000050000000000000000000000000000000005000000000000000000000000000000000500000000000000000000000000000000050000000000000000000000000000000005000000000000000000000000000000000500000000000000000000000000000000050000000000000000000000000000000000000000000000000680325000000000000000000086349908356807104602402447439670B000400590006310826200002000000306011031A16",
  },
};

/** 构造一条稳定的 9021 回归样例，偏移严格对应大口径水表 · 4G解析器。 */
function createWotman9021() {
  const frame = new Array<number>(92).fill(0);
  frame.splice(
    0,
    14,
    0x68,
    0x10,
    0x01,
    0x02,
    0x03,
    0x04,
    0x05,
    0x06,
    0x07,
    // DATA 共 80 字节，长度字段必须是低字节在前的 50 00。
    0x81,
    0x50,
    0x00,
    0x90,
    0x21,
  );
  frame[19] = 0x02;
  frame[15] = 0x01;
  frame[17] = 0x01;
  frame.splice(20, 6, 0x30, 0x14, 0x20, 0x08, 0x26, 0x0f);
  frame.splice(26, 8, 0x56, 0x34, 0x12, 0x00, 0x01, 0x35, 0x12, 0x00);
  frame.splice(34, 6, 0x67, 0x35, 0x12, 0x00, 0xd2, 0x04);
  frame.splice(44, 3, 0x65, 0x03, 0x25);
  frame.splice(
    56,
    16,
    0x86,
    0x01,
    0x23,
    0x45,
    0x67,
    0x89,
    0x01,
    0x23,
    0x46,
    0x00,
    0x12,
    0x34,
    0x56,
    0x78,
    0x90,
    0x12,
  );
  frame.splice(76, 7, 0x00, 0x30, 0x14, 0x20, 0x08, 0x26, 0x20);
  frame.splice(83, 9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00);
  return frame;
}

/** 页面统一消费数组形式的样例目录，保留 samples 键值以兼容原有调用。 */
export const sampleList = Object.values(samples).filter(
  (sample) => sample.protocolId !== "modbus-rtu",
);
