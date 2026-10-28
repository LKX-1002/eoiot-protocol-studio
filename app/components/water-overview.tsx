import type { ParseResult } from "@/lib/protocols/types";
import { waterOverview } from "@/lib/protocols/water-overview";

/** 不重复顶部读数与异常；仅展示额外业务值、通信与折叠技术字段。 */
export function WaterOverview({
  result,
  onHistory,
}: {
  result: ParseResult;
  onHistory?: () => void;
}) {
  const model = waterOverview(result);
  const hasCommunication =
    model.signals.length > 0 || model.equipment.length > 0 || !!model.reportReason;
  const text = (value: string | number | null) =>
    typeof value === "number" ? value.toLocaleString("zh-CN", { maximumFractionDigits: 3 }) : value;
  const displayTime = (value: string | number | null) =>
    String(value ?? "无").replace(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
      (_, year, month, day, hour, minute, second) =>
        `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${minute}:${second ?? "00"}`,
    );
  return (
    <div className="water-overview-clean">
      {(model.measurements.length > 0 || model.acquisition || hasCommunication) && (
        <div className="water-business-panel">
          {model.measurements.length > 0 && (
            <section className="water-detail-section">
              <h3>补充计量数据</h3>
              <dl>
                {model.measurements.map((item) => (
                  <div key={item.key}>
                    <dt>{item.label}</dt>
                    <dd>
                      {text(item.value)} <small>{item.unit}</small>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {model.acquisition && (
            <section className="water-detail-section acquisition-section" aria-label="采集与上报">
              <h3>采集与上报</h3>
              <dl>
                <div className="acquisition-primary">
                  <dt>采集间隔</dt>
                  <dd>
                    {model.acquisition.rawInterval == null ? (
                      "未提供"
                    ) : (
                      <>
                        {model.acquisition.rawInterval}
                        <small> 分钟</small>
                      </>
                    )}
                  </dd>
                  <p>{model.acquisition.frequency} · 由间隔换算</p>
                </div>
                <div>
                  <dt>上报方式</dt>
                  <dd>{model.reportReason ?? "未提供"}</dd>
                </div>
                <div>
                  <dt>{result.dataIdentifier === "9025" ? "采集器实时时间" : "水表实时时间"}</dt>
                  <dd className="acquisition-time">
                    {model.acquisition.realtime === "—" ? "无" : String(model.acquisition.realtime)}
                  </dd>
                </div>
              </dl>
            </section>
          )}
          {hasCommunication && (
            <section className="water-detail-section water-communication-section">
              <h3>{model.acquisition ? "设备与通信" : "通信参数"}</h3>
              <dl>
                {model.reportReason && !model.acquisition && (
                  <div>
                    <dt>上报方式</dt>
                    <dd>{model.reportReason}</dd>
                  </div>
                )}
                {model.signals.map((item) => (
                  <div key={item.key}>
                    <dt>{item.label}</dt>
                    <dd>{text(item.value)}</dd>
                  </div>
                ))}
                {model.equipment.map((item) => (
                  <div
                    key={item.key}
                    className={
                      item.key === "failureCount" && Number(item.value) > 0
                        ? "communication-attention"
                        : ""
                    }
                  >
                    <dt>{item.label}</dt>
                    <dd>
                      {text(item.value)} <small>{item.unit}</small>
                    </dd>
                  </div>
                ))}
              </dl>
              {result.protocolId === "cjt188-small" && <p>按协议解码后的信号值</p>}
            </section>
          )}
        </div>
      )}
      {model.acquisition && (
        <section className="history-summary-panel" aria-label="本帧历史数据摘要">
          <header>
            <h3>本帧历史数据</h3>
            {model.acquisition.actualCount > 0 && (
              <button type="button" onClick={onHistory}>
                查看历史明细 →
              </button>
            )}
          </header>
          <dl>
            <div>
              <dt>实际解析</dt>
              <dd>
                <strong>{model.acquisition.actualCount}</strong>
                <small> 条</small>
              </dd>
            </div>
            <div>
              <dt>报文声明</dt>
              <dd>
                {model.acquisition.declaredCount ?? "未提供"}
                <small> 条</small>
              </dd>
            </div>
            <div>
              <dt>分帧位置</dt>
              <dd>
                {String(model.acquisition.frameIndex)}
                <small> / </small>
                {String(model.acquisition.totalFrames)}
                <small> 帧</small>
              </dd>
            </div>
          </dl>
          {model.acquisition.actualCount > 0 && (
            <div className="history-time-range">
              <span>历史时间范围</span>
              <div>
                <time>{displayTime(model.acquisition.firstTime)}</time>
                <span aria-hidden="true"> → </span>
                <time>{displayTime(model.acquisition.lastTime)}</time>
              </div>
              <small>首条时间来自报文，后续时间按采集间隔推算。</small>
            </div>
          )}
          {model.acquisition.declaredCount !== model.acquisition.actualCount && (
            <p className="history-integrity-warning" role="status">
              声明条数与实际解析条数不一致，请检查报文完整性。
            </p>
          )}
          {model.acquisition.intervalMinutes == null && (
            <p className="history-integrity-warning" role="status">
              采集间隔为零或未提供，不能确认采集频率及历史时间间隔。
            </p>
          )}
          <p>仅统计当前帧，未合并其他帧；不据此推断整批历史记录总数或上报周期。</p>
        </section>
      )}
      <details className="water-technical-details">
        <summary>
          报文信息{" "}
          <span>
            {result.rawBytes.length} Bytes · DI {result.dataIdentifier}
          </span>
        </summary>
        <dl className="water-technical-grid">
          <div>
            <dt>控制码</dt>
            <dd>{result.controlCode}</dd>
          </div>
          <div>
            <dt>数据区长度</dt>
            <dd>{result.dataLength} Bytes</dd>
          </div>
          <div>
            <dt>已识别字段</dt>
            <dd>{result.fields.length} 项</dd>
          </div>
          <div>
            <dt>帧检查</dt>
            <dd>{result.diagnostics.some((item) => item.level === "bad") ? "存在错误" : "通过"}</dd>
          </div>
          {result.metrics.statusWord && result.metrics.statusWord !== "—" && (
            <div>
              <dt>状态字</dt>
              <dd>{String(result.metrics.statusWord)}</dd>
            </div>
          )}
        </dl>
        {model.technical.map((section) => (
          <section key={section.id}>
            <h4>{section.title}</h4>
            <dl className="water-technical-grid">
              {section.items.map((item) => (
                <div key={item.key}>
                  <dt>{item.label}</dt>
                  <dd>
                    {text(item.value)} {item.unit}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p>完整字段与原始字节请查看“字段解释”或 JSON。</p>
      </details>
    </div>
  );
}
