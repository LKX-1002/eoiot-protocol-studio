import { Fragment, type ReactNode } from "react";
import type { ParseRecord } from "@/lib/records/record-store";
import { ThemedSelect } from "./themed-select";

interface RecordsPageProps {
  records: ParseRecord[];
  recordStorageNotice: string;
  recordSearch: string;
  recordProtocol: string;
  recordProtocols: string[];
  visibleRecords: ParseRecord[];
  expandedRecordId: string | null;
  setRecordSearch: (value: string) => void;
  setRecordProtocol: (value: string) => void;
  setExpandedRecordId: (value: string | null) => void;
  clearRecords: () => void;
  reuseRecord: (record: ParseRecord) => void;
  deleteRecord: (id: string) => void;
  copyText: (text: string, label: string) => void;
  setView: (view: "studio" | "samples") => void;
  emptyIcon: ReactNode;
}

/** 记录页仅负责展示和交互，持久化与协议重解析由调用方提供。 */
export function RecordsPage({
  records,
  recordStorageNotice,
  recordSearch,
  recordProtocol,
  recordProtocols,
  visibleRecords,
  expandedRecordId,
  setRecordSearch,
  setRecordProtocol,
  setExpandedRecordId,
  clearRecords,
  reuseRecord,
  deleteRecord,
  copyText,
  setView,
  emptyIcon,
}: RecordsPageProps) {
  return (
    <section className="page collection-page records-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">LOCAL HISTORY</p>
          <h1>解析记录</h1>
          <span>共 {records.length} 条 · 仅保存在当前浏览器，最多保留最近 20 条</span>
        </div>
        <div className="heading-actions">
          <button
            className="records-clear"
            type="button"
            disabled={!records.length && !recordStorageNotice}
            onClick={clearRecords}
          >
            清空记录
          </button>
          <button className="primary-link" type="button" onClick={() => setView("studio")}>
            返回工作台
          </button>
        </div>
      </div>
      {recordStorageNotice && (
        <p className="record-storage-notice" role="status">
          {recordStorageNotice}
        </p>
      )}
      {records.length ? (
        <div className="records-panel">
          <div className="records-toolbar">
            <label className="records-search">
              <span>搜索记录</span>
              <input
                className="search-input"
                type="search"
                value={recordSearch}
                onChange={(event) => setRecordSearch(event.target.value)}
                placeholder="搜索表号、协议或解析结果"
              />
            </label>
            <label className="records-filter">
              <span>协议筛选</span>
              <ThemedSelect
                label="协议筛选"
                value={recordProtocol}
                onChange={setRecordProtocol}
                options={[
                  { value: "", label: "全部协议" },
                  ...recordProtocols.map((protocol) => ({ value: protocol, label: protocol })),
                ]}
              />
            </label>
            <span className="records-count" role="status">
              {visibleRecords.length} 条记录 · 时间倒序
            </span>
          </div>
          {visibleRecords.length ? (
            <table className="records-table">
              <thead>
                <tr>
                  <th scope="col">解析时间</th>
                  <th scope="col">表号</th>
                  <th scope="col">协议 / 报文类型</th>
                  <th scope="col">解析结果</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleRecords.map((record) => {
                  const expanded = expandedRecordId === record.id;
                  const date = new Date(record.createdAt);
                  const byteCount = record.raw.replace(/\s/g, "").length / 2;
                  return (
                    <Fragment key={record.id}>
                      <tr className={expanded ? "record-expanded" : ""}>
                        <td data-label="解析时间">
                          <time dateTime={record.createdAt}>
                            <span>{date.toLocaleDateString("zh-CN")}</span>
                            <strong>{date.toLocaleTimeString("zh-CN", { hour12: false })}</strong>
                          </time>
                        </td>
                        <td data-label="表号" className="record-meter">
                          {record.meterNo || "—"}
                        </td>
                        <td data-label="协议 / 报文类型" className="record-protocol">
                          {record.protocol}
                        </td>
                        <td data-label="解析结果" className="record-value">
                          {record.coreValue || "—"}
                        </td>
                        <td className="record-actions">
                          <div>
                            <button
                              type="button"
                              aria-expanded={expanded}
                              aria-controls={`record-hex-${record.id}`}
                              onClick={() => setExpandedRecordId(expanded ? null : record.id)}
                            >
                              {expanded ? "收起" : "查看"}
                            </button>
                            <button type="button" onClick={() => reuseRecord(record)}>
                              重新解析
                            </button>
                            <button
                              className="record-delete"
                              type="button"
                              aria-label={`删除表号 ${record.meterNo} 的这条记录`}
                              onClick={() => deleteRecord(record.id)}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="record-detail-row">
                          <td colSpan={5}>
                            <section
                              className="record-hex"
                              id={`record-hex-${record.id}`}
                              aria-label="原始报文"
                            >
                              <header>
                                <strong>原始报文</strong>
                                <span>{byteCount} Bytes</span>
                                <button
                                  type="button"
                                  onClick={() => copyText(record.raw, "历史报文")}
                                >
                                  复制 HEX
                                </button>
                              </header>
                              <code>{record.raw}</code>
                            </section>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="records-no-results">
              <strong>没有找到匹配记录</strong>
              <p>试试其他表号或协议名称。</p>
              <button
                type="button"
                onClick={() => {
                  setRecordSearch("");
                  setRecordProtocol("");
                }}
              >
                重置筛选
              </button>
            </div>
          )}
          <footer className="records-footer">
            记录时间为本机解析时间，原始报文可展开查看与复制。
          </footer>
        </div>
      ) : (
        <div className="large-empty">
          <span>{emptyIcon}</span>
          <h2>还没有解析记录</h2>
          <p>完成一次报文解析后，它会自动出现在这里。</p>
          <button className="primary-link" type="button" onClick={() => setView("samples")}>
            使用样例开始
          </button>
        </div>
      )}
    </section>
  );
}
