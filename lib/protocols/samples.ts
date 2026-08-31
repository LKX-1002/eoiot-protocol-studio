import { hex } from "./bytes";

/** 为示例帧计算从 68 开始的累加和，并补齐 CS 与结束符 16。 */
function withChecksum(frameWithoutChecksum: number[]) {
  const start = frameWithoutChecksum.indexOf(0x68);
  const checksum = frameWithoutChecksum.slice(start).reduce((sum, value) => (sum + value) & 0xff, 0);
  return [...frameWithoutChecksum, checksum, 0x16];
}

/**
 * 样例库固定保留四种业务报文各一条。
 * 9020、9023、9025 使用用户提供的真实帧；HTML 末尾空格标记不属于报文，未写入样例值。
 */
export const samples = {
  cjt188: {
    id: "joymeter-9020-report",
    name: "Joymeter 9020 主动上报",
    protocolId: "cjt188-small",
    description: "小口径水表主动上报，包含计量、时间、状态及 4G 网络信息。",
    value: "FE FE 68 10 46 43 47 00 05 51 00 81 26 90 20 00 56 11 00 00 29 95 01 00 00 29 46 00 03 31 08 26 20 00 00 00 00 00 00 00 00 29 30 FF FF FF FF 5C 0A 0F 14 EA 16",
  },
  wotman9021: {
    id: "wotman-9021-history",
    name: "沃特曼 9021 历史数据",
    protocolId: "wotman-big",
    description: "9021 大口径水表历史累计量报文；当前暂用项目原有校验样例。",
    value: hex(withChecksum(createWotman9021())),
  },
  wotman9023: {
    id: "wotman-9023-history",
    name: "沃特曼 9023 历史数据",
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
    name: "沃特曼 9025 采集器上报",
    protocolId: "wotman-big",
    description: "9025 采集器主动上报，历史记录按 A、B、C、D 四项解析。",
    value: "68106455000005430081260190251A020002000C00193008263C22111150000000000000000000000000000000005000000000000000000000000000000000500000000000000000000000000000000050000000000000000000000000000000005000000000000000000000000000000000500000000000000000000000000000000050000000000000000000000000000000005000000000000000000000000000000000500000000000000000000000000000000050000000000000000000000000000000005000000000000000000000000000000000500000000000000000000000000000000050000000000000000000000000000000000000000000000000680325000000000000000000086349908356807104602402447439670B000400590006310826200002000000306011031A16",
  },
};

/** 构造一条稳定的 9021 回归样例，偏移严格对应沃特曼解析器。 */
function createWotman9021() {
  const frame = new Array<number>(92).fill(0);
  frame.splice(0, 14,
    0x68, 0x10, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    // DATA 共 80 字节，长度字段必须是低字节在前的 50 00。
    0x81, 0x50, 0x00, 0x90, 0x21,
  );
  frame[19] = 0x02;
  frame[15] = 0x01;
  frame[17] = 0x01;
  frame.splice(20, 6, 0x30, 0x14, 0x20, 0x08, 0x26, 0x0f);
  frame.splice(26, 8, 0x56, 0x34, 0x12, 0x00, 0x01, 0x35, 0x12, 0x00);
  frame.splice(34, 6, 0x67, 0x35, 0x12, 0x00, 0xd2, 0x04);
  frame.splice(44, 3, 0x65, 0x03, 0x25);
  frame.splice(56, 16,
    0x86, 0x01, 0x23, 0x45, 0x67, 0x89, 0x01, 0x23,
    0x46, 0x00, 0x12, 0x34, 0x56, 0x78, 0x90, 0x12,
  );
  frame.splice(76, 7, 0x00, 0x30, 0x14, 0x20, 0x08, 0x26, 0x20);
  frame.splice(83, 9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00);
  return frame;
}

/** 页面统一消费数组形式的样例目录，保留 samples 键值以兼容原有调用。 */
export const sampleList = Object.values(samples);
