import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

interface SelectOption {
  value: string;
  label: string;
}
type MenuStyle = CSSProperties & { [key: `--${string}`]: string | undefined };

/** 与工作台主题一致的下拉菜单；菜单浮于面板外，并支持完整键盘操作。 */
export function ThemedSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [menuStyle, setMenuStyle] = useState<MenuStyle>({});
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < 180 && above > below;
      const maxHeight = Math.max(72, Math.min(280, upwards ? above : below));
      const width = Math.min(Math.max(rect.width, 190), window.innerWidth - 20);
      const colors = getComputedStyle(button);
      setMenuStyle({
        position: "fixed",
        left: Math.max(10, Math.min(rect.left, window.innerWidth - width - 10)),
        width,
        maxHeight,
        ...(upwards ? { bottom: window.innerHeight - rect.top + 5 } : { top: rect.bottom + 5 }),
        fontFamily: colors.fontFamily,
        "--select-panel": colors.getPropertyValue("--panel"),
        "--select-ink": colors.getPropertyValue("--ink"),
        "--select-muted": colors.getPropertyValue("--muted"),
        "--select-line": colors.getPropertyValue("--line"),
        "--select-brand": colors.getPropertyValue("--brand"),
        "--select-soft": colors.getPropertyValue("--brand-soft"),
      } as MenuStyle);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (open) menu.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option || disabled) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="theme-select">
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        disabled={disabled}
        onClick={() => {
          setActive(selected);
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            setOpen(false);
            return;
          }
          if (event.key === "Escape") {
            setOpen(false);
            event.stopPropagation();
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            if (!open) {
              setActive(selected);
              setOpen(true);
            } else setActive((current) => (current + direction + options.length) % options.length);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            setOpen(true);
            setActive(event.key === "Home" ? 0 : options.length - 1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) choose(active);
            else {
              setActive(selected);
              setOpen(true);
            }
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const now = Date.now();
            const text =
              (now - search.current.at < 700 ? search.current.text : "") + event.key.toLowerCase();
            search.current = { text, at: now };
            const match = options.findIndex((option) =>
              option.label.toLowerCase().startsWith(text),
            );
            if (match >= 0) {
              event.preventDefault();
              setActive(match);
              setOpen(true);
            }
          }
        }}
      >
        <span>{options[selected]?.label ?? value}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={menu}
            id={`${id}-menu`}
            role="listbox"
            aria-label={label}
            className="theme-select-menu"
            style={menuStyle}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={`${index === active ? "is-active" : ""}${option.value === value ? " is-selected" : ""}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === value && (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m3 8 3 3 7-7" />
                  </svg>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
