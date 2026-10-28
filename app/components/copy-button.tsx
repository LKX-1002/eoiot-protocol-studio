/** 仅渲染现有复制样式；剪贴板、反馈状态和计时由工作台统一管理。 */
export function CopyButton({
  label = "复制",
  ariaLabel,
  copied,
  disabled = false,
  onCopy,
}: {
  label?: string;
  ariaLabel: string;
  copied: boolean;
  disabled?: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      className={copied ? "is-success" : ""}
      onClick={onCopy}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {copied ? (
          <path d="m5 12 4 4L19 6" />
        ) : (
          <>
            <rect x="8" y="8" width="11" height="12" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
          </>
        )}
      </svg>
      <span>{copied ? "已复制" : label}</span>
    </button>
  );
}
