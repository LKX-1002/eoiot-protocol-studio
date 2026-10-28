import { hexByte } from "./bytes";

/** 小口径水表 · 4G 两字节水表状态字的逐位结果；状态字按低字节在前传输。 */
export interface JoymeterStatus {
  value: number;
  rawHex: string;
  valveCode: number;
  valveStatus: string;
  alarms: string[];
  items: Array<{ key: string; label: string; active: boolean; value: string }>;
}

const ALARM_BITS = [
  { bit: 2, key: "batteryLow", label: "电池欠压" },
  { bit: 3, key: "emptyPipe", label: "空管" },
  { bit: 4, key: "bubbleAlarm", label: "气泡报警" },
  { bit: 5, key: "temperatureSensor", label: "温度传感器异常" },
  { bit: 8, key: "storageAlarm", label: "存储器异常" },
  { bit: 9, key: "magneticAlarm", label: "磁干扰异常" },
  { bit: 10, key: "disassemblyAlarm", label: "拆卸异常" },
  { bit: 11, key: "overSpeedAlarm", label: "超流速异常" },
  { bit: 12, key: "reverseFlowAlarm", label: "逆流异常" },
  { bit: 13, key: "flowSensorAlarm", label: "流量传感器异常" },
  { bit: 14, key: "leakAlarm", label: "漏水异常" },
  { bit: 15, key: "reverseInstallation", label: "反向安装异常" },
] as const;

/**
 * 解析 小口径水表 · 4G 状态 ST。bits 0–1 为阀门状态，bits 6–7 为保留位，
 * 其余告警位严格按用户提供的状态字表解释。
 */
export function parseJoymeterStatus(raw: number[]): JoymeterStatus {
  const value = (raw[0] ?? 0) | ((raw[1] ?? 0) << 8);
  const valveCode = value & 0x03;
  const valveStatus =
    valveCode === 0
      ? "开启"
      : valveCode === 1
        ? "关闭"
        : valveCode === 3
          ? "阀门异常"
          : "保留状态（10B）";
  const items = ALARM_BITS.map(({ bit, key, label }) => {
    const active = (value & (1 << bit)) !== 0;
    return { key, label, active, value: active ? "异常" : "正常" };
  });
  return {
    value,
    rawHex: `${hexByte(raw[1] ?? 0)}${hexByte(raw[0] ?? 0)}`,
    valveCode,
    valveStatus,
    alarms: items.filter((item) => item.active).map((item) => item.label),
    items,
  };
}
