import { useState } from "react";
export type FrameToolOutput = {
  frame: string;
  checksum: string;
  range: string;
  rangeLabel: string;
  rule: string;
};
export function FrameToolResult({
  result,
  error,
  title,
}: {
  result: FrameToolOutput | null;
  error: string;
  title: string;
}) {
  const [feedback, setFeedback] = useState<{ frame: string; text: string } | null>(null);
  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.frame);
      setFeedback({ frame: result.frame, text: "已复制" });
    } catch {
      setFeedback({ frame: result.frame, text: "复制失败，请手动复制" });
    }
  };
  return (
    <section className="panel command-result-panel frame-tool-result">
      <div className="panel-title">
        <div>
          <span className="step">02</span>
          <strong>生成结果</strong>
        </div>
        <span className="byte-count">
          {result ? "已自动计算" : error ? "请检查参数" : "等待输入"}
        </span>
      </div>
      {result ? (
        <>
          <div className="command-summary">
            <div>
              <span>校验值（发送顺序）</span>
              <strong>{result.checksum}</strong>
            </div>
            <div>
              <span>完整帧长度</span>
              <strong>{result.frame.split(" ").length} Bytes</strong>
            </div>
            <div>
              <span>计算方式</span>
              <strong>本地计算</strong>
            </div>
          </div>
          <div className="command-output">
            <div className="command-output-head">
              <div>
                <strong>完整 HEX 指令</strong>
                <span>已补齐校验码，可直接复制</span>
              </div>
              <button type="button" onClick={copy}>
                {feedback?.frame === result.frame ? feedback.text : "复制完整帧"}
              </button>
            </div>
            <textarea readOnly value={result.frame} aria-label="完整 HEX 指令" />
          </div>
          <div className="frame-calculation">
            <h3>校验计算</h3>
            <dl>
              <div>
                <dt>计算规则</dt>
                <dd>{result.rule}</dd>
              </div>
              <div>
                <dt>参与范围</dt>
                <dd>{result.rangeLabel}</dd>
              </div>
            </dl>
            <code>{result.range}</code>
            <p>仅生成报文，不会连接设备或发送指令。</p>
          </div>
        </>
      ) : (
        <>
          <div className="command-summary">
            <div>
              <span>校验值</span>
              <strong>—</strong>
            </div>
            <div>
              <span>完整帧长度</span>
              <strong>—</strong>
            </div>
            <div>
              <span>状态</span>
              <strong>{error ? "参数待修正" : "等待输入"}</strong>
            </div>
          </div>
          <div className="command-output">
            <div className="command-output-head">
              <div>
                <strong>完整 HEX 指令</strong>
                <span>{title} · 填写参数后自动生成</span>
              </div>
              <button type="button" disabled>
                复制完整帧
              </button>
            </div>
            <textarea
              readOnly
              value=""
              aria-label="完整 HEX 指令"
              placeholder={error || "填写左侧参数后，完整帧将显示在这里。"}
            />
          </div>
          <div className="frame-calculation">
            <h3>计算过程</h3>
            <p>{error || "尚无可计算的数据。"}</p>
          </div>
        </>
      )}
    </section>
  );
}
