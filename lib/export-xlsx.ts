interface XlsxColumn {
  title: string;
  width: number;
  wrap?: boolean;
}

interface XlsxOptions {
  filename: string;
  sheetName: string;
  columns: XlsxColumn[];
  rows: string[][];
}

const encoder = new TextEncoder();

function xmlEscape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function inlineStringCell(address: string, value: string, style: number) {
  const preserve = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : "";
  return `<c r="${address}" t="inlineStr" s="${style}"><is><t${preserve}>${xmlEscape(value)}</t></is></c>`;
}

function buildWorksheet(columns: XlsxColumn[], rows: string[][]) {
  const lastColumn = columnName(columns.length - 1);
  const allRows = [columns.map((column) => column.title), ...rows];
  const sheetRows = allRows.map((row, rowIndex) => {
    const cells = columns.map((column, columnIndex) => inlineStringCell(`${columnName(columnIndex)}${rowIndex + 1}`, row[columnIndex] ?? "", rowIndex === 0 ? 1 : column.wrap ? 3 : 2)).join("");
    return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="24" customHeight="1"' : ""}>${cells}</row>`;
  }).join("");
  const columnWidths = columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`).join("");
  const lastRow = Math.max(allRows.length, 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columnWidths}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/><pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.2" footer="0.2"/></worksheet>`;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const value of data) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function concat(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** 以 ZIP store 模式打包 OOXML，避免在浏览器端引入体积较大的表格依赖。 */
function zip(entries: Array<{ name: string; content: string }>) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    writeU32(local, 0, 0x04034b50); writeU16(local, 4, 20); writeU16(local, 6, 0x0800); writeU16(local, 8, 0);
    writeU32(local, 14, checksum); writeU32(local, 18, data.length); writeU32(local, 22, data.length); writeU16(local, 26, name.length);
    local.set(name, 30); local.set(data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    writeU32(central, 0, 0x02014b50); writeU16(central, 4, 20); writeU16(central, 6, 20); writeU16(central, 8, 0x0800); writeU16(central, 10, 0);
    writeU32(central, 16, checksum); writeU32(central, 20, data.length); writeU32(central, 24, data.length); writeU16(central, 28, name.length); writeU32(central, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralDirectory = concat(centralParts);
  const end = new Uint8Array(22);
  writeU32(end, 0, 0x06054b50); writeU16(end, 8, entries.length); writeU16(end, 10, entries.length); writeU32(end, 12, centralDirectory.length); writeU32(end, 16, localOffset);
  return concat([...localParts, centralDirectory, end]);
}

export function createXlsxBlob(columns: XlsxColumn[], rows: string[][], sheetName = "批量指令") {
  const safeSheetName = sheetName.replace(/[\\/?*\[\]:]/g, " ").slice(0, 31) || "Sheet1";
  const worksheet = buildWorksheet(columns, rows);
  const files = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><bottom style="thin"><color rgb="FFD8E2E5"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment vertical="center"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", content: worksheet },
  ];
  return new Blob([zip(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function downloadXlsx({ filename, sheetName, columns, rows }: XlsxOptions) {
  const blob = createXlsxBlob(columns, rows, sheetName);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
