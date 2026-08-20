import { hexByte } from "./bytes";

/** CJ/T 188-2018 水表类型：10H~13H 已定义，14H~19H 为水表类别保留码。 */
const DEFINED_WATER_METER_TYPES: Record<number, string> = {
  0x10: "冷水水表",
  0x11: "生活热水水表",
  0x12: "直饮水水表",
  0x13: "中水水表",
};

export interface WaterMeterType {
  code: number;
  codeLabel: string;
  label: string;
  reserved: boolean;
}

/** 返回完整水表类别 10H~19H 的名称；非水表类型返回 null。 */
export function getWaterMeterType(code: number | undefined): WaterMeterType | null {
  if (code === undefined || code < 0x10 || code > 0x19) return null;
  const definedLabel = DEFINED_WATER_METER_TYPES[code];
  return {
    code,
    codeLabel: `${hexByte(code)}H`,
    label: definedLabel ?? "水表保留类型",
    reserved: !definedLabel,
  };
}

