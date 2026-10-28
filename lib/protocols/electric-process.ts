import { findFrameStart, hex, hexByte } from "./bytes";
import { describeDlt645Energy } from "./dlt645-capabilities";
import type { ParseResult } from "./types";

/** 解释已验证的解析结果，不建立第二套电量解析规则。 */
export function electricProcess(result: ParseResult) {
  const start = findFrameStart(result.rawBytes);
  const wire = result.rawBytes.slice(start + 10, start + 10 + result.dataLength);
  const decoded = wire.map((value) => (value - 0x33 + 256) & 0xff);
  const info = describeDlt645Energy(result.dataIdentifier);
  const checksumOffset = start + 10 + result.dataLength;
  const sum = result.rawBytes
    .slice(start, checksumOffset)
    .reduce((total, value) => total + value, 0);
  const values = result.fields
    .filter((item) => item.tone === "value")
    .map((item) => {
      const position = item.offset - start - 10;
      const bytes = decoded.slice(position, position + item.length);
      const negative = info?.kind === "00" && (bytes[3] & 0x80) !== 0;
      const magnitude = [...bytes];
      if (info?.kind === "00") magnitude[3] &= 0x7f;
      return {
        label: item.name,
        raw: item.raw,
        decoded: hex(bytes),
        ordered: hex([...magnitude].reverse()),
        negative,
        value: item.value,
        unit: item.unit,
      };
    });
  return {
    wire: hex(wire),
    decoded: hex(decoded),
    diBytes: hex(decoded.slice(0, 4)),
    di: result.dataIdentifier,
    frame: result.fields.filter((item) => item.tone !== "value" && item.name !== "数据标识 DI"),
    values,
    sum,
    calculatedChecksum: hexByte(sum & 0xff),
    receivedChecksum: hexByte(result.rawBytes[checksumOffset]),
    request: result.controlCode === "11H",
  };
}
