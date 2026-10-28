import type { ParseResult } from "@/lib/protocols/types";
import { smallMeterStatus } from "@/lib/protocols/water-status";

/** 小口径 4G / MBus 共用状态呈现，通信信息按实际协议展示。 */
export function WaterStatusPanel({ result }: { result: ParseResult }) {
  const status = smallMeterStatus(result);
  const mbus = result.protocolId === "joymeter-mbus";
  const bad = result.diagnostics.some((item) => item.level === "bad");
  const text = (key: string) => {
    const value = result.metrics[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
    }
    return value == null || value === "—" || value === "" ? "无" : String(value);
  };
  return (
    <section className="water-status-panel" aria-label="设备状态与通信">
      <header>
        <h3>通信与状态详情</h3>
        <span>{bad ? "报文检查异常" : "字段完整"}</span>
      </header>
      <div className="water-communication">
        <div>
          <span>{mbus ? "通信类型" : "上报方式"}</span>
          <strong>{mbus ? "抄表应答" : text("reportReason")}</strong>
        </div>
        {mbus ? (
          <div>
            <span>结算日累计量</span>
            <strong>
              {text("settlementFlow")}{" "}
              {typeof result.metrics.settlementFlow === "number" ? "m³" : ""}
            </strong>
          </div>
        ) : (
          <div className="water-signals">
            <span>4G 信号值</span>
            <dl>
              {["rssi", "rsrq", "rsrp"].map((key) => (
                <div key={key}>
                  <dt>{key.toUpperCase()}</dt>
                  <dd>{text(key)}</dd>
                </div>
              ))}
            </dl>
            <small>按协议解码后的信号值</small>
          </div>
        )}
      </div>
      <footer>
        {status.label} ·{" "}
        {status.word ? `状态字 ${status.word} · 按两字节状态位解释` : "状态字缺失或无法确定"}
      </footer>
    </section>
  );
}
