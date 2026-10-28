/** 当前电能量 DI 按 DI3→DI0 展示；DI0=00 为当前值，不包含历史结算日。 */
export const dlt645EnergyKinds = [
  { value: "00", label: "组合有功电能", name: "组合有功" },
  { value: "01", label: "正向有功电能", name: "正向有功" },
  { value: "02", label: "反向有功电能", name: "反向有功" },
] as const;
export const dlt645RateOptions = [
  { value: "00", label: "总电能" },
  ...Array.from({ length: 8 }, (_, index) => ({
    value: String(index + 1).padStart(2, "0"),
    label: `费率 ${index + 1}`,
  })),
  { value: "FF", label: "全部费率数据块" },
];

export function describeDlt645Energy(di: string) {
  if (!/^00(?:00|01|02)(?:00|0[1-8]|FF)00$/.test(di)) return null;
  const kind = dlt645EnergyKinds.find((item) => item.value === di.slice(2, 4))!;
  return {
    kind: kind.value,
    energyType: kind.name,
    block: di.slice(4, 6) === "FF",
    rate: parseInt(di.slice(4, 6), 16),
  };
}
