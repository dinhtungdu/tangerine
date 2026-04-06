import { useState, useMemo, useRef, useEffect, useCallback } from "react"
import { prepareWithSegments } from "@chenglou/pretext"
import type { PreparedTextWithSegments } from "@chenglou/pretext"
import { copyToClipboard } from "../lib/clipboard"
import type { DiffFile } from "../lib/api"
import type { DiffComment } from "./ChangesPanel"

type ViewMode = "split" | "unified"

interface SplitLine {
  left: { num: number; content: string; type: "remove" | "context" } | null
  right: { num: number; content: string; type: "add" | "context" } | null
}

export function getFileStats(diff: string) {
  let added = 0
  let removed = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

export function fileName(path: string): string {
  return path.split("/").pop() ?? path
}

export function fileDir(path: string): string {
  const parts = path.split("/")
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ""
}

// Access pretext's internal per-segment widths (branded type hides them)
type PreparedInternals = PreparedTextWithSegments & { widths: number[] }

// Prepare once, then walk segment widths to find the truncation point — no repeated measurement
function middleTruncate(path: string, font: string, maxWidth: number): string {
  const prepared = prepareWithSegments(path, font) as PreparedInternals
  const { segments, widths } = prepared
  const totalWidth = widths.reduce((a, b) => a + b, 0)
  if (totalWidth <= maxWidth) return path

  const ellipsis = "\u2026"
  const ellipsisW = (prepareWithSegments(ellipsis, font) as PreparedInternals).widths[0] ?? 0
  const available = maxWidth - ellipsisW
  if (available <= 0) return ellipsis

  // Find where the filename starts in the segment list
  const name = fileName(path)
  const dirLen = path.length - name.length
  let charCount = 0
  let nameStartSeg = segments.length
  for (let i = 0; i < segments.length; i++) {
    if (charCount >= dirLen) { nameStartSeg = i; break }
    charCount += segments[i]!.length
  }

  const nameW = widths.slice(nameStartSeg).reduce((a, b) => a + b, 0)

  if (nameW >= available) {
    // Filename alone overflows — walk segments from the end
    let w = 0
    for (let i = segments.length - 1; i >= nameStartSeg; i--) {
      w += widths[i]!
      if (w > available) {
        const kept = segments.slice(i + 1).join("")
        return kept ? ellipsis + kept : ellipsis
      }
    }
    return ellipsis + name
  }

  // Walk dir segments forward until we exceed budget
  const dirBudget = available - nameW
  let w = 0
  for (let i = 0; i < nameStartSeg; i++) {
    w += widths[i]!
    if (w > dirBudget) {
      const kept = segments.slice(0, i).join("")
      return (kept || "") + ellipsis + name
    }
  }
  return path
}

function MiddleTruncatedPath({ path, className }: { path: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [display, setDisplay] = useState(path)

  const recompute = useCallback(() => {
    const el = ref.current
    if (!el) return
    const w = el.clientWidth
    if (w <= 0) { setDisplay(path); return }
    const style = getComputedStyle(el)
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    setDisplay(middleTruncate(path, font, w))
  }, [path])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(recompute)
    observer.observe(el)
    return () => observer.disconnect()
  }, [recompute])

  return (
    <span ref={ref} className={className} title={path} style={{ display: "block", overflow: "hidden", whiteSpace: "nowrap", textAlign: "left" }}>
      {display}
    </span>
  )
}

function parseSplitLines(diff: string): SplitLine[] {
  const rawLines = diff.split("\n")
  const result: SplitLine[] = []
  let leftNum = 0
  let rightNum = 0
  let removes: string[] = []
  let adds: string[] = []

  function flushPending() {
    const max = Math.max(removes.length, adds.length)
    for (let i = 0; i < max; i++) {
      result.push({
        left: i < removes.length
          ? { num: leftNum - removes.length + i + 1, content: removes[i] ?? "", type: "remove" }
          : null,
        right: i < adds.length
          ? { num: rightNum - adds.length + i + 1, content: adds[i] ?? "", type: "add" }
          : null,
      })
    }
    removes = []
    adds = []
  }

  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      flushPending()
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
      if (match) {
        leftNum = parseInt(match[1]!) - 1
        rightNum = parseInt(match[2]!) - 1
      }
      continue
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue
    if (line.startsWith("-")) {
      leftNum++
      removes.push(line.slice(1))
    } else if (line.startsWith("+")) {
      rightNum++
      adds.push(line.slice(1))
    } else {
      flushPending()
      leftNum++
      rightNum++
      const content = line.startsWith(" ") ? line.slice(1) : line
      result.push({
        left: { num: leftNum, content, type: "context" },
        right: { num: rightNum, content, type: "context" },
      })
    }
  }
  flushPending()
  return result
}

// Inline comment form that appears between diff lines
function InlineCommentForm({ onSubmit, onCancel, rangeLabel }: { onSubmit: (text: string) => void; onCancel: () => void; rangeLabel?: string | null }) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { ref.current?.focus() }, [])

  return (
    <div className="mx-4 my-2 rounded-lg border border-edge bg-surface p-3 shadow-sm">
      {rangeLabel && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-fg-muted">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
          </svg>
          Add a comment on {rangeLabel}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey && text.trim()) {
            e.preventDefault()
            onSubmit(text.trim())
          }
          if (e.key === "Escape") onCancel()
        }}
        placeholder="Add a comment..."
        className="w-full resize-none rounded-md border border-edge bg-surface px-3 py-2 text-base text-fg placeholder:text-fg-faint focus:border-status-info focus:outline-none md:text-md"
        rows={3}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-md font-medium text-fg-muted hover:text-fg"
        >
          Cancel
        </button>
        <button
          onClick={() => { if (text.trim()) onSubmit(text.trim()) }}
          disabled={!text.trim()}
          className="rounded-md bg-fg px-4 py-1.5 text-md font-medium text-surface hover:bg-fg/90 disabled:opacity-40"
        >
          Comment
        </button>
      </div>
    </div>
  )
}

type Side = "left" | "right"

interface LineRange {
  start: number
  end: number
  side: Side
}

// GitHub-style: mousedown on "+" starts drag within one pane, mouseup opens form
function useLineComment(
  filePath: string,
  getLineNum: (index: number, side: Side) => number,
  onAddComment?: (comment: DiffComment) => void,
) {
  const [dragging, setDragging] = useState(false)
  const [anchor, setAnchor] = useState<{ index: number; side: Side } | null>(null)
  const [selection, setSelection] = useState<LineRange | null>(null)
  const [showForm, setShowForm] = useState(false)

  const handleGutterMouseDown = (lineIndex: number, side: Side) => {
    if (!onAddComment) return
    setShowForm(false)
    setAnchor({ index: lineIndex, side })
    setSelection({ start: lineIndex, end: lineIndex, side })
    setDragging(true)
  }

  const handleLineMouseEnter = (lineIndex: number, side: Side) => {
    if (!dragging || anchor === null) return
    // Only extend within the same pane
    if (side !== anchor.side) return
    const start = Math.min(anchor.index, lineIndex)
    const end = Math.max(anchor.index, lineIndex)
    setSelection({ start, end, side: anchor.side })
  }

  useEffect(() => {
    if (!dragging) return
    const onUp = () => { setDragging(false); setShowForm(true) }
    window.addEventListener("mouseup", onUp)
    return () => window.removeEventListener("mouseup", onUp)
  }, [dragging])

  const getLineRef = (range: LineRange): string => {
    const prefix = range.side === "left" ? "L" : "R"
    const startNum = getLineNum(range.start, range.side)
    const endNum = getLineNum(range.end, range.side)
    return startNum === endNum ? `${prefix}${startNum}` : `${prefix}${startNum}-${endNum}`
  }

  const getRangeLabel = (): string | null => {
    if (!selection) return null
    const side = selection.side === "left" ? "Before" : "After"
    const startNum = getLineNum(selection.start, selection.side)
    const endNum = getLineNum(selection.end, selection.side)
    if (startNum === endNum) return `${side} line ${startNum}`
    return `${side} lines ${startNum} to ${endNum}`
  }

  const handleSubmit = (text: string) => {
    if (!selection) return
    onAddComment?.({
      id: `${filePath}-${getLineRef(selection)}-${Date.now()}`,
      filePath,
      lineRef: getLineRef(selection),
      side: selection.side,
      text,
    })
    setSelection(null)
    setShowForm(false)
    setAnchor(null)
  }

  const handleCancel = () => {
    setSelection(null)
    setShowForm(false)
    setAnchor(null)
  }

  const isInSelection = (i: number, side: Side) =>
    selection && selection.side === side && i >= selection.start && i <= selection.end

  return { handleGutterMouseDown, handleLineMouseEnter, handleSubmit, handleCancel, isInSelection, showForm, selection, getRangeLabel }
}

// The "+" button shown on hover in the gutter
// GitHub-style gutter: "+" button appears to the left of line number on hover
function LineNum({ num, canComment, onMouseDown }: { num: number | string; canComment?: boolean; onMouseDown?: (e: React.MouseEvent) => void }) {
  return (
    <span className="group/gutter flex w-12 shrink-0 items-start select-none">
      {canComment ? (
        <button
          onMouseDown={(e) => { e.preventDefault(); onMouseDown?.(e) }}
          className="flex h-[22px] w-5 items-center justify-center opacity-0 group-hover/gutter:opacity-100"
          aria-label="Add comment"
        >
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded bg-status-info text-white">
            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </span>
        </button>
      ) : (
        <span className="w-5" />
      )}
      <span className="w-7 text-right text-fg-faint">{num}</span>
    </span>
  )
}

function SplitDiff({ diff, filePath, onAddComment }: { diff: string; filePath: string; onAddComment?: (comment: DiffComment) => void }) {
  const lines = useMemo(() => parseSplitLines(diff), [diff])

  const getLineNum = (i: number, side: Side) => {
    const line = lines[i]!
    return side === "left" ? (line.left?.num ?? i + 1) : (line.right?.num ?? i + 1)
  }

  const { handleGutterMouseDown, handleLineMouseEnter, handleSubmit, handleCancel, isInSelection, showForm, selection, getRangeLabel } =
    useLineComment(filePath, getLineNum, onAddComment)

  return (
    <div className="w-full overflow-hidden">
      <div className="flex w-full">
        <div className="min-w-0 flex-1 border-r border-edge">
          <div className="flex h-8 items-center bg-surface-secondary px-4">
            <span className="font-mono text-xxs font-medium text-fg-muted">Before</span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex h-8 items-center bg-surface-secondary px-4">
            <span className="font-mono text-xxs font-medium text-fg-muted">After</span>
          </div>
        </div>
      </div>
      <div className="py-1">
        {lines.map((line, i) => {
          const l = line.left
          const r = line.right
          const leftBg = l?.type === "remove" ? "bg-diff-remove-bg" : ""
          const rightBg = r?.type === "add" ? "bg-diff-add-bg" : ""
          const leftSelected = isInSelection(i, "left")
          const rightSelected = isInSelection(i, "right")
          return (
            <div key={i}>
              <div className="flex w-full">
                <div
                  className={`flex min-h-[22px] min-w-0 flex-1 border-r border-edge font-mono text-xxs ${leftBg} ${leftSelected ? "border-l-2 border-l-status-info bg-status-info/5" : ""}`}
                  onMouseEnter={() => handleLineMouseEnter(i, "left")}
                >
                  <LineNum num={l?.num ?? ""} canComment={!!onAddComment} onMouseDown={() => handleGutterMouseDown(i, "left")} />
                  <span className={`min-w-0 flex-1 whitespace-pre-wrap break-all px-2 ${l?.type === "remove" ? "text-diff-remove" : "text-fg-muted"}`}>
                    {l?.content ?? ""}
                  </span>
                </div>
                <div
                  className={`flex min-h-[22px] min-w-0 flex-1 font-mono text-xxs ${rightBg} ${rightSelected ? "border-l-2 border-l-status-info bg-status-info/5" : ""}`}
                  onMouseEnter={() => handleLineMouseEnter(i, "right")}
                >
                  <LineNum num={r?.num ?? ""} canComment={!!onAddComment} onMouseDown={() => handleGutterMouseDown(i, "right")} />
                  <span className={`min-w-0 flex-1 whitespace-pre-wrap break-all px-2 ${r?.type === "add" ? "text-diff-add" : "text-fg-muted"}`}>
                    {r?.content ?? ""}
                  </span>
                </div>
              </div>
              {showForm && selection?.end === i && (
                <InlineCommentForm onSubmit={handleSubmit} onCancel={handleCancel} rangeLabel={getRangeLabel()} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UnifiedDiff({ diff, filePath, onAddComment }: { diff: string; filePath: string; onAddComment?: (comment: DiffComment) => void }) {
  const rawLines = diff.split("\n")

  const lineNums = useMemo(() => {
    let num = 0
    return rawLines.map((line) => {
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
        if (match) num = parseInt(match[1]!) - 1
      }
      if (line.startsWith("+") && !line.startsWith("+++")) num++
      else if (!line.startsWith("-") && !line.startsWith("@@")) num++
      return num
    })
  }, [rawLines])

  const getLineNum = (i: number) => lineNums[i] ?? i + 1

  const { handleGutterMouseDown, handleLineMouseEnter, handleSubmit, handleCancel, isInSelection, showForm, selection, getRangeLabel } =
    useLineComment(filePath, getLineNum, onAddComment)

  return (
    <pre className="w-full whitespace-pre-wrap break-all py-2 font-mono text-xxs leading-[1.7]">
      {rawLines.map((line, i) => {
        if (line.startsWith("---") || line.startsWith("+++")) return null

        const color = line.startsWith("+") ? "text-diff-add bg-diff-add-bg"
          : line.startsWith("-") ? "text-diff-remove bg-diff-remove-bg"
          : line.startsWith("@@") ? "text-diff-hunk"
          : "text-fg-muted"
        const selected = isInSelection(i, "right")
        return (
          <span key={i} className="block">
            <span className="flex items-start" onMouseEnter={() => handleLineMouseEnter(i, "right")}>
              <LineNum num={lineNums[i] ?? ""} canComment={!!onAddComment} onMouseDown={() => handleGutterMouseDown(i, "right")} />
              <span className={`flex-1 px-2 ${selected ? "border-l-2 border-status-info bg-status-info/5" : ""} ${color}`}>
                {line}
              </span>
            </span>
            {showForm && selection?.end === i && (
              <InlineCommentForm onSubmit={handleSubmit} onCancel={handleCancel} rangeLabel={getRangeLabel()} />
            )}
          </span>
        )
      })}
    </pre>
  )
}

function FileSection({ file, onAddComment }: { file: DiffFile; onAddComment?: (comment: DiffComment) => void }) {
  const [collapsed, setCollapsed] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>("split")
  const [copied, setCopied] = useState(false)
  const stats = useMemo(() => getFileStats(file.diff), [file.diff])

  return (
    <div className="border-b border-edge">
      <div className="flex h-12 items-center justify-between bg-surface px-5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 group/path">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex min-w-0 flex-1 items-center gap-1.5"
          >
            <svg
              className={`h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform ${collapsed ? "" : "rotate-90"}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <svg className="h-3.5 w-3.5 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            <MiddleTruncatedPath path={file.path} className="min-w-0 flex-1 font-mono text-md font-medium text-fg" />
          </button>
          <button
            onClick={() => { copyToClipboard(file.path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }).catch(() => {}) }}
            className="shrink-0 opacity-0 group-hover/path:opacity-100 transition-opacity text-fg-muted hover:text-fg"
            title="Copy path"
          >
            {copied ? (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
              </svg>
            )}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-xs font-semibold text-diff-add">+{stats.added}</span>
          <span className="text-xs font-semibold text-diff-remove">&minus;{stats.removed}</span>
          <div className="hidden overflow-hidden rounded-md border border-edge @min-[900px]:flex">
            <button
              onClick={() => setViewMode("split")}
              className={`px-2.5 py-1 text-xxs font-medium ${viewMode === "split" ? "bg-surface-secondary text-fg" : "text-fg-muted"}`}
            >
              Split
            </button>
            <button
              onClick={() => setViewMode("unified")}
              className={`border-l border-edge px-2.5 py-1 text-xxs font-medium ${viewMode === "unified" ? "bg-surface-secondary text-fg" : "text-fg-muted"}`}
            >
              Unified
            </button>
          </div>
        </div>
      </div>
      {!collapsed && (
        <>
          {/* Narrow container: always unified */}
          <div className="@min-[900px]:hidden">
            <UnifiedDiff diff={file.diff} filePath={file.path} onAddComment={onAddComment} />
          </div>
          {/* Wide container: respect toggle */}
          <div className="hidden @min-[900px]:block">
            {viewMode === "split"
              ? <SplitDiff diff={file.diff} filePath={file.path} onAddComment={onAddComment} />
              : <UnifiedDiff diff={file.diff} filePath={file.path} onAddComment={onAddComment} />
            }
          </div>
        </>
      )}
    </div>
  )
}

interface DiffViewProps {
  files: DiffFile[]
  onAddComment?: (comment: DiffComment) => void
}

export function DiffView({ files, onAddComment }: DiffViewProps) {
  if (files.length === 0) return null

  return (
    <div className="@container h-full overflow-x-hidden overflow-y-auto bg-surface">
      {files.map((file) => (
        <div key={file.path} id={`diff-file-${file.path}`}>
          <FileSection file={file} onAddComment={onAddComment} />
        </div>
      ))}
    </div>
  )
}
