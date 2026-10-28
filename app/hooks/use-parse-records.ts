import { useEffect, useRef, useState } from "react";
import { protocolDisplayName } from "@/lib/protocols/display-name";
import { createLocalRecordStore, RECORD_LIMIT, type ParseRecord } from "@/lib/records/record-store";

/** 页面状态与持久化隔离；接入账号接口时不改变解析流程。 */
export function useParseRecords() {
  const [store] = useState(() => createLocalRecordStore(() => window.localStorage));
  const [records, setRecords] = useState<ParseRecord[]>([]);
  const [notice, setNotice] = useState("");
  const current = useRef<ParseRecord[]>([]);
  const writable = useRef(true);
  useEffect(() => {
    const loaded = store.load();
    loaded.records = loaded.records.map((record) => ({
      ...record,
      protocol: protocolDisplayName(record.protocol),
    }));
    current.current = loaded.records;
    writable.current = loaded.writable;
    setRecords(loaded.records);
    setNotice(loaded.notice);
  }, [store]);
  const replace = (next: ParseRecord[]) => {
    current.current = next;
    setRecords(next);
    if (!writable.current) {
      setNotice(
        "本机记录未覆盖（原数据需要恢复或迁移），新增内容仅暂存于本次页面。可先导出重要报文，再确认清空。",
      );
      return;
    }
    const saved = store.save(next);
    setNotice(saved.notice);
  };
  return {
    records,
    notice,
    addRecord: (record: ParseRecord) =>
      replace([record, ...current.current].slice(0, RECORD_LIMIT)),
    removeRecord: (id: string) => replace(current.current.filter((record) => record.id !== id)),
    clearRecords: () => {
      const result = store.clear();
      setNotice(result.notice);
      if (result.ok) {
        writable.current = true;
        current.current = [];
        setRecords([]);
      }
      return result.ok;
    },
  };
}
