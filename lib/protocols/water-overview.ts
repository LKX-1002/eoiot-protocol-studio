import type { OverviewSection, ParseResult } from "./types";

/** 概览展示分工：主读数在顶部，通信只一处，剩余字段归入技术详情。 */
export function waterOverview(result: ParseResult) {
  const big = result.protocolId === "wotman-big";
  const mbus = result.protocolId === "joymeter-mbus";
  const interval = result.metrics.collectionIntervalMinutes;
  const validInterval = typeof interval === "number" && interval > 0 ? interval : null;
  const frequency =
    validInterval == null
      ? "无法换算"
      : validInterval === 60
        ? "每小时 1 次"
        : validInterval < 60
          ? `每小时约 ${Number((60 / validInterval).toFixed(3))} 次`
          : `每 ${Number((validInterval / 60).toFixed(3))} 小时 1 次`;
  const acquisition = big
    ? {
        intervalMinutes: validInterval,
        rawInterval: typeof interval === "number" ? interval : null,
        frequency,
        declaredCount:
          typeof result.metrics.declaredHistoryCount === "number"
            ? result.metrics.declaredHistoryCount
            : null,
        actualCount: result.history.length,
        firstTime: result.metrics.firstHistoryTime ?? "—",
        lastTime:
          validInterval == null && result.history.length > 1
            ? "无法推算"
            : (result.history.at(-1)?.collectTime ?? "—"),
        realtime: result.metrics.collectTime ?? "—",
        frameIndex: result.metrics.frameIndex ?? "—",
        totalFrames: result.metrics.totalFrames ?? "—",
      }
    : null;
  const present = (value: string | number | null | undefined) =>
    value != null && value !== "—" && value !== "";
  const signals = (big ? ["csq"] : mbus ? [] : ["rssi", "rsrq", "rsrp"])
    .filter((key) => present(result.metrics[key]))
    .map((key) => ({ key, label: key.toUpperCase(), value: result.metrics[key] }));
  const primaryKeys = new Set([
    "currentFlow",
    "forwardFlow",
    "settlementFlow",
    "meterTime",
    "collectTime",
    "meterNo",
    "command",
    "purpose",
    "reportReason",
    "statusInfo",
    "statusWord",
    "valveStatus",
    "statusNormal",
    "frames",
  ]);
  const signalKeys = new Set(["csq", "rssi", "rsrq", "rsrp", "snr", "ecl", "pci"]);
  const measurementKeys = new Set(["reverseFlow", "instantFlow", "pressure", "temperature"]);
  const measurements = result.overviewSections
    .flatMap((section) => section.items)
    .filter(
      (item) =>
        measurementKeys.has(item.key) &&
        !(big && item.key === "instantFlow") &&
        present(item.value),
    );
  const seen = new Set<string>();
  const equipment = big
    ? [
        { key: "meterVoltage", label: "表端电压", unit: "V" },
        { key: "collectorVoltage", label: "采集器电压", unit: "V" },
        { key: "successCount", label: "累计上线成功次数", unit: "次" },
        { key: "failureCount", label: "累计上线失败次数", unit: "次" },
      ]
        .filter((item) => present(result.metrics[item.key]))
        .map((item) => ({ ...item, value: result.metrics[item.key] }))
    : [];
  const technical: OverviewSection[] = result.overviewSections
    .map((section) => ({
      ...section,
      items:
        section.id === "status"
          ? []
          : section.items.filter((item) => {
              if (
                !present(item.value) ||
                primaryKeys.has(item.key) ||
                signalKeys.has(item.key) ||
                measurementKeys.has(item.key) ||
                equipment.some((equipmentItem) => equipmentItem.key === item.key) ||
                seen.has(item.key)
              )
                return false;
              seen.add(item.key);
              return true;
            }),
    }))
    .filter((section) => section.items.length > 0);
  return {
    signals,
    measurements,
    technical,
    acquisition,
    equipment,
    reportReason:
      !mbus && present(result.metrics.reportReason) ? String(result.metrics.reportReason) : null,
  };
}
