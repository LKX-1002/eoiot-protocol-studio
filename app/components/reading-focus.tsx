import type { ReactNode } from "react";
import type { ParseResult } from "@/lib/protocols/types";
import { smallMeterStatus } from "@/lib/protocols/water-status";

/** 身份、读数、相关指标集中展示；正常标记不占用一张指标卡。 */
export function ReadingFocus({
  result,
  number,
  unit,
  copy,
  children,
}: {
  result: ParseResult;
  number: string;
  unit: string;
  copy: () => void;
  children?: ReactNode;
}) {
  const electric = result.protocolId === "dlt645-energy";
  const mbus = result.protocolId === "joymeter-mbus";
  const small = mbus || result.protocolId === "cjt188-small";
  const status = small ? smallMeterStatus(result) : null;
  const errors = result.diagnostics.filter((item) => item.level === "bad");
  const bigStatus = String(result.metrics.statusInfo ?? "");
  const bigAlarm = /异常|故障|欠压|报警|漏水|拆卸|逆流/.test(bigStatus);
  const difference =
    electric &&
    typeof result.metrics.tariffDifference === "number" &&
    result.metrics.tariffDifference !== 0;
  const alarms = errors.length
    ? errors.map((item) => item.text)
    : status?.alarms.length
      ? status.alarms
      : bigAlarm
        ? [bigStatus]
        : difference
          ? ["累计量与费率合计存在差值，请核对表内配置"]
          : [];
  const timeKey = result.metrics.collectTime != null ? "collectTime" : "meterTime";
  const time = result.metrics[timeKey];
  const settlement = result.metrics.settlementFlow;
  const stateLabel = alarms.length
    ? `${alarms.length} 项需关注`
    : status
      ? status.label
      : electric
        ? "帧校验通过"
        : bigStatus && bigStatus !== "—"
          ? `设备状态：${bigStatus}`
          : "设备状态未提供";
  return (
    <section
      className={`meter-result-dashboard${electric ? " meter-electric-readings" : " meter-water-readings"}`}
      aria-label="重点读数与提醒"
    >
      <header className="meter-context-bar">
        <div>
          <h2>{result.protocol}</h2>
          <div className="meter-context-id">
            <span>表号</span>
            <strong>{result.meterNo}</strong>
            <button type="button" onClick={copy} aria-label="复制表号">
              复制
            </button>
          </div>
        </div>
        {alarms.length === 0 && (
          <span
            className={`meter-context-status${alarms.length ? " needs-attention" : status?.state === "unknown" ? " is-unknown" : ""}`}
          >
            {stateLabel}
          </span>
        )}
      </header>
      {alarms.length > 0 && (
        <aside className={`meter-inline-alert${errors.length ? " is-error" : ""}`} role="status">
          <strong>{errors.length ? "报文检查异常" : "需要关注"}</strong>
          <ul>
            {alarms.map((alarm) => (
              <li key={alarm}>{alarm}</li>
            ))}
          </ul>
        </aside>
      )}
      <div className="meter-kpi-row">
        <article className="meter-primary-kpi">
          <span>
            {electric
              ? Number(result.metrics.rate) > 0
                ? `费率 ${result.metrics.rate} 电量`
                : "累计用量"
              : "当前累计量"}
          </span>
          <p>
            <strong>{number}</strong>
            <span>{unit}</span>
          </p>
          {electric && <small>{String(result.metrics.readingMode ?? "电量解析")}</small>}
        </article>
        {electric ? (
          <>
            <article className="meter-secondary-kpi">
              <span>电能类型</span>
              <strong>{String(result.metrics.energyType ?? "—")}</strong>
            </article>
            <article className="meter-secondary-kpi">
              <span>报文用途</span>
              <strong>读数据应答</strong>
            </article>
          </>
        ) : (
          <>
            {typeof settlement === "number" && (
              <article className="meter-secondary-kpi">
                <span>结算日累计量</span>
                <p>
                  <strong>
                    {settlement.toLocaleString("zh-CN", { maximumFractionDigits: 3 })}
                  </strong>
                  <span>m³</span>
                </p>
              </article>
            )}
          </>
        )}
      </div>
      {!electric && result.protocolId !== "wotman-big" && (
        <div className="water-reading-time">
          <span>{timeKey === "collectTime" ? "采集时间" : "水表时间"}</span>
          <time>{time == null || time === "—" ? "无" : String(time)}</time>
        </div>
      )}
      {children}
    </section>
  );
}
