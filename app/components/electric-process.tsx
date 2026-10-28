import { Fragment } from "react";
import type { ParseResult } from "@/lib/protocols/types";
import { electricProcess } from "@/lib/protocols/electric-process";
import { CopyButton } from "./copy-button";

/** 概览只解释关键换算；完整结构继续使用字段解释和字节地图。 */
export function ElectricProcess({
  result,
  copied,
  onCopy,
}: {
  result: ParseResult;
  copied: boolean;
  onCopy: (text: string) => void;
}) {
  const process = electricProcess(result);
  const block = process.values.length > 1;
  const wireDi = process.wire.split(" ").slice(0, 4).join(" ");
  const explanation = [
    `表号：${result.meterNo}`,
    `DI：${process.di} · ${result.metrics.energyType} · ${result.metrics.readingMode}`,
    `DI传输字节：${wireDi} → 减33H：${process.diBytes} → 反转：${process.di}`,
    ...process.values.map(
      (item) =>
        `${item.label}：${item.raw} → 减33H：${item.decoded} → 反转${item.negative ? "并去除负号位" : ""}：${item.ordered} → BCD ÷100${item.negative ? "，负值" : ""} = ${item.value} ${item.unit}`,
    ),
    ...(process.request ? ["读取请求不包含电量，等待应答。"] : []),
    `CS：帧内 ${process.receivedChecksum} / 计算 ${process.calculatedChecksum}；累加和 ${process.sum} 取低8位，唤醒FE不参与。`,
  ].join("\n");
  const formula = (item: (typeof process.values)[number]) => (
    <>
      <code>{item.ordered}</code>
      <span>按 BCD 读取 ÷ 100{item.negative ? "，符号位为负" : ""}</span>
      <strong>
        {item.value} <small>{item.unit}</small>
      </strong>
    </>
  );
  return (
    <section className="electric-conversion" aria-label="电表解析过程">
      <header>
        <h3>电量解析</h3>
        <div className="tool-actions">
          <CopyButton
            label="复制解析说明"
            ariaLabel="复制解析说明"
            copied={copied}
            onCopy={() => onCopy(explanation)}
          />
        </div>
      </header>
      <dl className="conversion-identity">
        <div>
          <dt>数据标识</dt>
          <dd>
            <code>{wireDi}</code>
            <span>减 33H</span>
            <code>{process.diBytes}</code>
            <span>反转</span>
            <strong>{process.di}</strong>
          </dd>
        </div>
        <div>
          <dt>识别内容</dt>
          <dd>
            {String(result.metrics.energyType)} · {String(result.metrics.readingMode)}
          </dd>
        </div>
      </dl>
      {process.request ? (
        <p className="conversion-note">当前为读取请求，不包含电量；请粘贴电表应答查看换算结果。</p>
      ) : block ? (
        <div className="conversion-table-wrap">
          <table className="conversion-table">
            <thead>
              <tr>
                <th>数据项</th>
                <th>传输字节</th>
                <th>减 33H 后</th>
                <th>电量（kWh）</th>
              </tr>
            </thead>
            <tbody>
              {process.values.map((item, index) => (
                <Fragment key={index}>
                  <tr>
                    <th scope="row">{item.label}</th>
                    <td>
                      <code>{item.raw}</code>
                    </td>
                    <td>
                      <code>{item.decoded}</code>
                    </td>
                    <td>
                      <strong>{item.value}</strong>
                    </td>
                  </tr>
                  <tr className="conversion-expand-row">
                    <td colSpan={4}>
                      <details>
                        <summary>查看{item.label}换算过程</summary>
                        <div className="conversion-formula">{formula(item)}</div>
                      </details>
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        process.values.map((item, index) => (
          <dl className="conversion-single" key={index}>
            <div>
              <dt>电量字节</dt>
              <dd>
                <code>{item.raw}</code>
              </dd>
            </div>
            <div>
              <dt>减 33H 后</dt>
              <dd>
                <code>{item.decoded}</code>
              </dd>
            </div>
            <div>
              <dt>低字节在前</dt>
              <dd className="conversion-formula">{formula(item)}</dd>
            </div>
          </dl>
        ))
      )}
      <details className="conversion-check">
        <summary>
          <span>
            CS {process.receivedChecksum === process.calculatedChecksum ? "校验一致" : "校验不一致"}
          </span>
          <span>
            帧内 {process.receivedChecksum} · 计算 {process.calculatedChecksum}
          </span>
          <span>查看过程</span>
        </summary>
        <p>
          从第一个 68H 至数据域末尾逐字节累加：{process.sum} → 取低 8 位 →{" "}
          <code>{process.calculatedChecksum}</code>。唤醒 FE 不参与计算。
        </p>
      </details>
    </section>
  );
}
