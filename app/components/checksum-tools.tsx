import { useMemo, useState } from "react";
import { parseHex } from "@/lib/protocols/bytes";
import { calculateFrameChecksum, type ChecksumKind } from "@/lib/protocols/checksum-tool";
import { ModbusRequestBuilder } from "./modbus-request-builder";
import { ThemedSelect } from "./themed-select";
import { FrameToolResult } from "./frame-tool-result";
import { ElectricRequestBuilder } from "./electric-request-builder";

export function ChecksumTools({ mode }: { mode: string }) {
  const [kind, setKind] = useState<ChecksumKind>("cs");
  const [input, setInput] = useState("");
  const computed = useMemo(() => {
    if (!input.trim()) return { result: null, error: "" };
    try {
      return { result: calculateFrameChecksum(parseHex(input), kind), error: "" };
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : "无法计算" };
    }
  }, [kind, input]);
  return (
    <>
      <div hidden={mode !== "electric"}>
        <ElectricRequestBuilder />
      </div>
      <div hidden={mode !== "build"}>
        <ModbusRequestBuilder />
      </div>
      <div hidden={mode !== "checksum"}>
        <div className="command-workbench frame-tools-workbench">
          <section className="panel command-form-panel">
            <div className="panel-title">
              <div>
                <span className="step">01</span>
                <strong>参数设置</strong>
              </div>
              <span className="byte-count">实时计算</span>
            </div>
            <div className="command-function-context">校验和计算</div>
            <div className="command-form frame-tool-form">
              <label>
                <span>校验算法</span>
                <ThemedSelect
                  label="校验算法"
                  value={kind}
                  options={[
                    { value: "modbus", label: "Modbus RTU · CRC16" },
                    { value: "cs", label: "CS 校验和（645 / 188）" },
                  ]}
                  onChange={(value) => setKind(value as ChecksumKind)}
                />
              </label>
              <label>
                <span>待计算 HEX</span>
                <textarea
                  value={input}
                  spellCheck={false}
                  aria-label="待计算 HEX"
                  placeholder={
                    kind === "modbus"
                      ? "输入不含 CRC 的报文"
                      : "输入完整帧头与数据域，不含 CS 和结束符 16"
                  }
                  onChange={(event) => setInput(event.target.value)}
                />
                <small>
                  {kind === "modbus"
                    ? "对全部输入字节计算 CRC16，低字节先发。"
                    : "从起始 68 累加至数据域末尾，前导 FE 不参与，自动补 CS 和 16。"}
                </small>
              </label>
              {computed.error && (
                <p className="modbus-config-error" role="alert">
                  {computed.error}
                </p>
              )}
              <p className="frame-tool-note">已有校验码请先移除；填写后自动计算，无需点击按钮。</p>
            </div>
          </section>
          <FrameToolResult result={computed.result} error={computed.error} title="校验结果" />
        </div>
      </div>
    </>
  );
}
