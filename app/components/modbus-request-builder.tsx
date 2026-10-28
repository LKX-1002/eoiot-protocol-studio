import { useMemo, useState } from "react";
import { hex } from "@/lib/protocols/bytes";
import { buildModbusReadRequest } from "@/lib/protocols/modbus";
import { ThemedSelect } from "./themed-select";
import { FrameToolResult } from "./frame-tool-result";

export function ModbusRequestBuilder() {
  const [form, setForm] = useState({
    slave: "1",
    functionCode: "3",
    address: "",
    quantity: "1",
    radix: "16",
  });
  const update = (patch: Partial<typeof form>) => {
    setForm((current) => ({ ...current, ...patch }));
  };
  const computed = useMemo(() => {
    if (![form.slave, form.address, form.quantity].every((value) => value.trim()))
      return { bytes: null, error: "" };
    try {
      const text = form.address.trim().replace(/^0x/i, "");
      if (!(form.radix === "16" ? /^[0-9a-f]+$/i : /^\d+$/).test(text))
        throw new Error("寄存器地址与所选进制不匹配。");
      return {
        bytes: buildModbusReadRequest(
          Number(form.slave),
          Number(form.functionCode),
          parseInt(text, Number(form.radix)),
          Number(form.quantity),
        ),
        error: "",
      };
    } catch (caught) {
      return { bytes: null, error: caught instanceof Error ? caught.message : "请检查组帧参数。" };
    }
  }, [form]);
  const bytes = computed.bytes;
  return (
    <div className="command-workbench frame-tools-workbench">
      <section className="panel command-form-panel">
        <div className="panel-title">
          <div>
            <span className="step">01</span>
            <strong>参数设置</strong>
          </div>
          <span className="byte-count">实时组帧</span>
        </div>
        <div className="command-function-context">Modbus组帧</div>
        <div className="command-form frame-tool-form">
          <label>
            <span>从站地址</span>
            <input
              value={form.slave}
              inputMode="numeric"
              placeholder="1–247"
              onChange={(event) => update({ slave: event.target.value })}
            />
          </label>
          <label>
            <span>功能码</span>
            <ThemedSelect
              label="组帧功能码"
              value={form.functionCode}
              options={[
                { value: "3", label: "03 · 读保持寄存器" },
                { value: "4", label: "04 · 读输入寄存器" },
              ]}
              onChange={(value) => update({ functionCode: value })}
            />
          </label>
          <label>
            <span>地址进制</span>
            <ThemedSelect
              label="寄存器地址进制"
              value={form.radix}
              options={[
                { value: "16", label: "十六进制 HEX" },
                { value: "10", label: "十进制 DEC" },
              ]}
              onChange={(value) => update({ radix: value, address: "" })}
            />
          </label>
          <label>
            <span>寄存器起始地址</span>
            <input
              value={form.address}
              placeholder={form.radix === "16" ? "例如 0029" : "例如 41"}
              onChange={(event) => update({ address: event.target.value })}
            />
          </label>
          <label>
            <span>寄存器数量</span>
            <input
              value={form.quantity}
              inputMode="numeric"
              placeholder="1–125"
              onChange={(event) => update({ quantity: event.target.value })}
            />
          </label>
          <p className="frame-tool-note">
            从站地址、数量使用十进制；寄存器地址按所选进制输入，从 0 计，不自动转换 40001
            等显示编号。填写完整后自动计算 CRC。
          </p>
          {computed.error && (
            <p className="modbus-config-error" role="alert">
              {computed.error}
            </p>
          )}
        </div>
      </section>
      <FrameToolResult
        title="生成指令"
        error={computed.error}
        result={
          bytes
            ? {
                frame: hex(bytes),
                checksum: hex(bytes.slice(-2)),
                range: hex(bytes.slice(0, -2)),
                rangeLabel: "从站地址至寄存器数量，共 6 Bytes",
                rule: "CRC16 / MODBUS · 初始 FFFF · 多项式 A001 · 低字节先发",
              }
            : null
        }
      />
    </div>
  );
}
