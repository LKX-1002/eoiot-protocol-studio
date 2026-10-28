/** 展示层兼容旧记录名称，不改协议 ID 或原始报文。 */
export function protocolDisplayName(value: string): string {
  return value
    .replace(/武汉沃特曼计量科技|武汉沃特曼大口径水表|武汉沃特曼|沃特曼/g, "大口径水表 · 4G")
    .replace(/Joymeter MBus(?: · 小口径水表)?/gi, "小口径水表 · MBus")
    .replace(/Joymeter 4G(?: · 小口径水表)?|Joymeter/gi, "小口径水表 · 4G");
}

/** 品牌名仅作为搜索别名，不作为页面标题展示。 */
export function protocolSearchAlias(value: string): string {
  return value.includes("大口径") ? "沃特曼 wotman" : value.includes("小口径") ? "Joymeter" : "";
}
