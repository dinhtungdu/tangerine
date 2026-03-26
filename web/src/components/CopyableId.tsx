import { useState, useCallback, type MouseEvent } from "react"

export function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback((e: MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [id])
  return (
    <button
      onClick={handleCopy}
      title="Copy task ID"
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-fg-muted hover:bg-surface-secondary hover:text-fg"
    >
      {copied ? "Copied!" : id.slice(0, 8)}
      {!copied && (
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}
