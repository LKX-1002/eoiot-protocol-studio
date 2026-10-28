import { useMemo, useState } from "react";
import { buildDlt645ReadCommand } from "@/lib/protocols/dlt645-command";
import { FrameToolResult } from "./frame-tool-result";
import { ThemedSelect } from "./themed-select";
import {
  dlt645EnergyKinds,
  dlt645RateOptions,
  describeDlt645Energy,
} from "@/lib/protocols/dlt645-capabilities";

export function ElectricRequestBuilder() {
  const [form, setForm] = useState({
    address: "",
    kind: "01",
    rate: "00",
    customDi: "",
    wake: "4",
  });
  const update = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const di = form.kind === "custom" ? form.customDi : `00${form.kind}${form.rate}00`;
  const computed = useMemo(() => {
    if (!form.address.trim() || !di.trim()) return { result: null, error: "" };
    try {
      return { result: buildDlt645ReadCommand(form.address, di, Number(form.wake)), error: "" };
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : "无法组帧" };
    }
  }, [form.address, di, form.wake]);
  return (
    <div className="command-workbench frame-tools-workbench">
      <section className="panel command-form-panel">
        <div className="panel-title">
          <div>
            <span className="step">01</span>
            <strong>参数设置</strong>
          </div>
          <span className="byte-count">DL/T 645-2007</span>
        </div>
        <div className="command-function-context">电表抄读指令</div>
        <div className="command-form frame-tool-form">
          <label>
            <span>电表地址 / 表号</span>
            <input
              value={form.address}
              maxLength={12}
              inputMode="numeric"
              placeholder="输入最多 12 位表号"
              onChange={(event) => update({ address: event.target.value })}
            />
            <small>按表上展示顺序输入，不要手动反转。短地址左侧补 0。</small>
          </label>
          <label>
            <span>抄读内容</span>
            <ThemedSelect
              label="抄读内容"
              value={form.kind}
              options={[...dlt645EnergyKinds, { value: "custom", label: "自定义数据标识 DI" }]}
              onChange={(kind) => update({ kind })}
            />
          </label>
          {form.kind === "custom" ? (
            <label>
              <span>自定义 DI（DI3→DI0）</span>
              <input
                value={form.customDi}
                maxLength={10}
                placeholder="例如 00010000"
                onChange={(event) => update({ customDi: event.target.value })}
              />
              <small>填写未加 33H 的原始 DI，具体支持项以设备协议为准。</small>
            </label>
          ) : (
            <label>
              <span>费率范围</span>
              <ThemedSelect
                label="费率范围"
                value={form.rate}
                options={dlt645RateOptions}
                onChange={(rate) => update({ rate })}
              />
              <small>费率 1–4 常用于尖、峰、平、谷，实际对应关系以表内配置为准。</small>
            </label>
          )}
          <label>
            <span>前导唤醒 FE</span>
            <ThemedSelect
              label="前导唤醒 FE"
              value={form.wake}
              options={[
                { value: "0", label: "不添加" },
                { value: "2", label: "2 个 FE" },
                { value: "4", label: "4 个 FE" },
              ]}
              onChange={(wake) => update({ wake })}
            />
          </label>
          <div className="electric-command-di">
            <span>数据标识 DI</span>
            <strong>{di.trim() || "—"}</strong>
            <small>固定控制码 11H · 数据域长度 04H · 自动计算 CS</small>
          </div>
          <small className="frame-tool-note">
            {describeDlt645Energy(di.toUpperCase())
              ? "当前预设同时支持生成请求和解析正常应答。费率数据块按实际返回的费率数量展示。"
              : "自定义 DI 可生成请求；除已列出的有功电能项外，暂未实现对应应答的业务解码。"}
          </small>
          {computed.error && (
            <p className="modbus-config-error" role="alert">
              {computed.error}
            </p>
          )}
          <p className="frame-tool-note">
            仅生成抄读请求，不修改电表参数。不使用 AA
            广播地址读取电量；设备不支持的数据项可能返回异常应答。
          </p>
        </div>
      </section>
      <div className="electric-command-result">
        <FrameToolResult title="生成指令" result={computed.result} error={computed.error} />
        {computed.result && (
          <section className="panel electric-command-details">
            <div className="panel-title">
              <strong>组帧说明</strong>
            </div>
            <dl>
              <div>
                <dt>电表地址</dt>
                <dd>{computed.result.meterNo}</dd>
              </div>
              <div>
                <dt>地址低字节先发</dt>
                <dd>
                  <code>{computed.result.addressHex}</code>
                </dd>
              </div>
              <div>
                <dt>原始 DI</dt>
                <dd>
                  <code>{computed.result.di}</code>
                </dd>
              </div>
              <div>
                <dt>DI 反转并加 33H</dt>
                <dd>
                  <code>{computed.result.encodedDi}</code>
                </dd>
              </div>
            </dl>
          </section>
        )}
      </div>
    </div>
  );
}
