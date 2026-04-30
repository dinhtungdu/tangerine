import { useState, useMemo, useRef, useEffect, useCallback } from "react"
import { PatchDiff } from "@pierre/diffs/react"
import type { DiffLineAnnotation } from "@pierre/diffs/react"
import type { SelectedLineRange } from "@pierre/diffs"
import { prepareWithSegments } from "@chenglou/pretext"
import type { PreparedTextWithSegments } from "@chenglou/pretext"
import { copyToClipboard } from "../lib/clipboard"
import type { DiffFile } from "../lib/api"
import type { DiffComment } from "./ChangesPanel"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

type ViewMode = "split" | "unified"

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

  const ellipsis = "…"
  const ellipsisW = (prepareWithSegments(ellipsis, font) as PreparedInternals).widths[0] ?? 0
  const available = maxWidth - ellipsisW
  if (available <= 0) return ellipsis

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

function InlineCommentForm({ onSubmit, onCancel, rangeLabel }: { onSubmit: (text: string) => void; onCancel: () => void; rangeLabel?: string | null }) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { ref.current?.focus() }, [])

  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-background p-3 shadow-sm">
      {rangeLabel && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
          </svg>
          Add a comment on {rangeLabel}
        </div>
      )}
      <Textarea
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
        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground/50 focus:border-status-info focus:outline-none md:text-sm"
        rows={3}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Cancel
        </Button>
        <Button
          onClick={() => { if (text.trim()) onSubmit(text.trim()) }}
          disabled={!text.trim()}
          size="sm"
          className="rounded-md bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-40"
        >
          Comment
        </Button>
      </div>
    </div>
  )
}

interface CommentAnnotation {
  comment: DiffComment
}

function useResolvedTheme() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"))

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return isDark ? "dark" as const : "light" as const
}

function FileSection({ file, comments = [], onAddComment }: { file: DiffFile; comments?: DiffComment[]; onAddComment?: (comment: DiffComment) => void }) {
  const [collapsed, setCollapsed] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>("split")
  const [copied, setCopied] = useState(false)
  const stats = useMemo(() => getFileStats(file.diff), [file.diff])
  const resolvedTheme = useResolvedTheme()

  const [pendingRange, setPendingRange] = useState<SelectedLineRange | null>(null)
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null)

  const handleGutterClick = useCallback((range: SelectedLineRange) => {
    if (!onAddComment) return
    setPendingRange(range)
    setSelectedLines(range)
  }, [onAddComment])

  const handleCommentSubmit = useCallback((text: string) => {
    if (!pendingRange) return
    const side = pendingRange.side === "deletions" ? "left" : "right"
    const prefix = side === "left" ? "L" : "R"
    const lineRef = pendingRange.start === pendingRange.end
      ? `${prefix}${pendingRange.start}`
      : `${prefix}${pendingRange.start}-${pendingRange.end}`
    onAddComment?.({
      id: `${file.path}-${lineRef}-${Date.now()}`,
      filePath: file.path,
      lineRef,
      side,
      text,
    })
    setPendingRange(null)
    setSelectedLines(null)
  }, [pendingRange, onAddComment, file.path])

  const handleCommentCancel = useCallback(() => {
    setPendingRange(null)
    setSelectedLines(null)
  }, [])

  const lineAnnotations = useMemo(() => {
    const annotations: DiffLineAnnotation<CommentAnnotation>[] = []
    for (const comment of comments) {
      const side = comment.side === "left" ? "deletions" : "additions"
      const ref = comment.lineRef.slice(1)
      const lineNum = ref.includes("-") ? Number(ref.split("-")[1]) : Number(ref)
      annotations.push({ side, lineNumber: lineNum, metadata: { comment } })
    }
    return annotations
  }, [comments])

  const rangeLabel = useMemo(() => {
    if (!pendingRange) return null
    const side = pendingRange.side === "deletions" ? "Before" : "After"
    if (pendingRange.start === pendingRange.end) return `${side} line ${pendingRange.start}`
    return `${side} lines ${pendingRange.start} to ${pendingRange.end}`
  }, [pendingRange])

  return (
    <div className="border-b border-border">
      <div className="flex h-12 items-center justify-between bg-background px-5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 group/path">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          >
            <svg
              className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${collapsed ? "" : "rotate-90"}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            <MiddleTruncatedPath path={file.path} className="min-w-0 flex-1 font-mono text-sm font-medium text-foreground" />
          </button>
          <button
            onClick={() => { copyToClipboard(file.path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }).catch(() => {}) }}
            className="shrink-0 rounded opacity-0 outline-none transition-opacity group-hover/path:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring/50"
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
          <div className="hidden overflow-hidden rounded-md border border-border @min-[900px]:flex">
            <button
              onClick={() => setViewMode("split")}
              className={`px-2.5 py-1 text-xxs font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${viewMode === "split" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
            >
              Split
            </button>
            <button
              onClick={() => setViewMode("unified")}
              className={`border-l border-border px-2.5 py-1 text-xxs font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${viewMode === "unified" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
            >
              Unified
            </button>
          </div>
        </div>
      </div>
      {!collapsed && (
        <>
          <PatchDiff<CommentAnnotation>
            patch={file.diff}
            options={{
              theme: { dark: "pierre-dark", light: "pierre-light" },
              themeType: resolvedTheme,
              diffStyle: viewMode,
              disableFileHeader: true,
              overflow: "wrap",
              enableGutterUtility: !!onAddComment,
              onGutterUtilityClick: handleGutterClick,
            }}
            lineAnnotations={lineAnnotations}
            selectedLines={selectedLines}
            renderAnnotation={(annotation) => (
              <div className="border-l-2 border-l-diff-comment bg-muted/30 px-4 py-2">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-2xs font-medium">{annotation.metadata.comment.lineRef}</span>
                  {annotation.metadata.comment.text}
                </p>
              </div>
            )}
          />
          {pendingRange && (
            <InlineCommentForm
              onSubmit={handleCommentSubmit}
              onCancel={handleCommentCancel}
              rangeLabel={rangeLabel}
            />
          )}
        </>
      )}
    </div>
  )
}

interface DiffViewProps {
  files: DiffFile[]
  comments?: DiffComment[]
  onAddComment?: (comment: DiffComment) => void
}

export function DiffView({ files, comments = [], onAddComment }: DiffViewProps) {
  if (files.length === 0) return null

  return (
    <div className="@container h-full overflow-x-hidden overflow-y-auto bg-background">
      {files.map((file) => (
        <div key={file.path} id={`diff-file-${file.path}`}>
          <FileSection
            file={file}
            comments={comments.filter((c) => c.filePath === file.path)}
            onAddComment={onAddComment}
          />
        </div>
      ))}
    </div>
  )
}
