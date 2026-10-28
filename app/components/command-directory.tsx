import { useEffect, useRef, useState } from "react";
import { protocolSearchAlias } from "@/lib/protocols/display-name";
export type DirectoryGroup = {
  id: string;
  label: string;
  items: { id: string; label: string; code: string; keywords?: string }[];
};
export function CommandDirectory({
  groups,
  selected,
  onSelect,
}: {
  groups: DirectoryGroup[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((group) => [group.id, true])),
  );
  const [open, setOpen] = useState(false);
  const aside = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const query = search.trim().toLowerCase();
  const visible = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${group.label} ${protocolSearchAlias(group.label)} ${item.label} ${item.code} ${item.keywords ?? ""}`
          .toLowerCase()
          .includes(query),
      ),
    }))
    .filter((group) => group.items.length);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    aside.current?.querySelector<HTMLInputElement>("input")?.focus();
    const resize = () => {
      if (window.innerWidth > 1200) setOpen(false);
    };
    window.addEventListener("resize", resize);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="command-directory-toggle"
        aria-expanded={open}
        aria-controls="unified-command-directory"
        onClick={() => setOpen(true)}
      >
        功能目录
        <span>
          {groups.flatMap((group) => group.items).find((item) => item.id === selected)?.label}
        </span>
      </button>
      {open && <div className="command-directory-backdrop" onClick={close} aria-hidden="true" />}
      <aside
        ref={aside}
        className={`command-directory unified-command-directory${open ? " is-open" : ""}`}
        id="unified-command-directory"
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label="功能目录"
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
          if (event.key === "Tab") {
            const elements = Array.from(
              aside.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input") ?? [],
            ).filter((element) => element.getClientRects().length);
            const first = elements[0],
              last = elements[elements.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="command-directory-header">
          <div className="unified-directory-title">
            <strong>指令目录</strong>
            <button type="button" className="directory-close" onClick={close}>
              关闭
            </button>
          </div>
          <label className="command-search">
            <span>搜索功能</span>
            <input
              className="search-input"
              value={search}
              placeholder="搜索功能、协议或 DI…"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </header>
        <nav>
          {visible.map((group) => (
            <section className="directory-group" key={group.id}>
              <button
                type="button"
                className="directory-group-toggle"
                aria-expanded={!!query || !collapsed[group.id]}
                onClick={() =>
                  setCollapsed((current) => ({ ...current, [group.id]: !current[group.id] }))
                }
              >
                <strong>{group.label}</strong>
                <span aria-hidden="true">{query || !collapsed[group.id] ? "−" : "+"}</span>
              </button>
              <div hidden={!query && !!collapsed[group.id]} className="command-flat-list">
                {group.items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`command-item-button${selected === item.id ? " active" : ""}`}
                    aria-current={selected === item.id ? "page" : undefined}
                    onClick={() => {
                      onSelect(item.id);
                      if (open) close();
                    }}
                  >
                    <span>{item.label}</span>
                    <code>{item.code}</code>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </nav>
        {!visible.length && <div className="command-directory-empty">没有匹配功能</div>}
      </aside>
    </>
  );
}
