import { useState, useMemo, useEffect } from "react"
import { DiffViewer, getDiffStats, type DiffStats } from "./DiffViewer"

export type ToolStatus = "running" | "success" | "error" | "interrupted"

interface ToolCallDisplayProps {
  content: string
  status?: ToolStatus
}

interface ToolCallData {
  tool?: string
  name?: string
  input?: Record<string, unknown>
  output?: string
  command?: string
  path?: string
  diff?: string
  file_path?: string
  pattern?: string
}

function parseToolCall(content: string): ToolCallData | null {
  try {
    return JSON.parse(content) as ToolCallData
  } catch {
    return null
  }
}

function getToolIcon(toolName: string): { icon: string; label: string } {
  const name = toolName.toLowerCase()
  if (name.includes("read") || name.includes("search")) return { icon: "file-search", label: "Read" }
  if (name.includes("write")) return { icon: "file-pen", label: "Write" }
  if (name.includes("edit")) return { icon: "file-pen", label: "Edit" }
  if (name.includes("bash") || name.includes("shell") || name.includes("exec")) return { icon: "terminal", label: "Bash" }
  if (name.includes("grep")) return { icon: "search", label: "Grep" }
  if (name.includes("glob")) return { icon: "folder", label: "Glob" }
  if (name.includes("agent")) return { icon: "agent", label: "Agent" }
  return { icon: "tool", label: "Tool" }
}

function getToolSummary(toolName: string, toolData: ToolCallData): string | null {
  const name = toolName.toLowerCase()
  const input = toolData.input

  if (name.includes("bash") || name.includes("shell") || name.includes("exec")) {
    const cmd = toolData.command || (input?.command as string)
    if (cmd) {
      const oneLine = cmd.replace(/\s+/g, " ").trim()
      return `$ ${oneLine}`
    }
  }

  if (name.includes("read")) {
    const path = toolData.path || toolData.file_path || (input?.file_path as string)
    if (path) return path
  }

  if (name.includes("write") || name.includes("edit")) {
    const path = toolData.path || toolData.file_path || (input?.file_path as string)
    if (path) return path
  }

  if (name.includes("grep")) {
    const pattern = toolData.pattern || (input?.pattern as string)
    const path = toolData.path || (input?.path as string)
    if (pattern) return `/${pattern}/${path ? ` in ${path}` : ""}`
  }

  if (name.includes("glob")) {
    const pattern = (input?.pattern as string)
    if (pattern) return pattern
  }

  if (name.includes("agent")) {
    const desc = (input?.description as string)
    if (desc) return desc
  }

  // Fallback: try common fields
  const desc = (input?.description as string)
  if (desc) return desc

  // Try file_path, path, command, pattern as generic fallbacks
  const filePath = toolData.file_path || toolData.path || (input?.file_path as string) || (input?.path as string)
  if (filePath) return filePath

  const cmd = toolData.command || (input?.command as string)
  if (cmd) return `$ ${cmd.replace(/\s+/g, " ").trim()}`

  const pattern = toolData.pattern || (input?.pattern as string)
  if (pattern) return pattern

  return null
}

function StatusIndicator({ status }: { status: ToolStatus }) {
  if (status === "running") {
    return (
      <svg className="h-3 w-3 animate-spin text-muted-foreground" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    )
  }

  const colors: Record<ToolStatus, string> = {
    running: "",
    success: "bg-status-success",
    error: "bg-status-error",
    interrupted: "bg-status-warning",
  }

  return <span className={`h-2 w-2 rounded-full ${colors[status]}`} />
}

export function ToolCallDisplay({ content, status = "success" }: ToolCallDisplayProps) {
  const toolData = parseToolCall(content)

  const editStrings = useMemo(() => {
    if (!toolData?.input) return null
    const input = toolData.input
    const oldStr = input.old_string as string | undefined
    const newStr = input.new_string as string | undefined
    const filePath = input.file_path as string | undefined
    if (typeof oldStr === "string" && typeof newStr === "string") {
      return { oldString: oldStr, newString: newStr, filePath }
    }
    return null
  }, [toolData])

  const diffStats = useMemo<DiffStats | null>(() => {
    if (!editStrings) return null
    return getDiffStats(editStrings.oldString, editStrings.newString)
  }, [editStrings])

  const shouldAutoExpand = diffStats ? diffStats.totalLines < 20 : false
  const [expanded, setExpanded] = useState(shouldAutoExpand)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (shouldAutoExpand) setExpanded(true)
  }, [shouldAutoExpand])

  if (!toolData) {
    return (
      <pre className="overflow-x-auto rounded-md border border-border bg-muted p-2 text-xxs text-muted-foreground">
        {content}
      </pre>
    )
  }

  const toolName = toolData.tool || toolData.name || "Tool Call"
  const nameLower = toolName.toLowerCase()
  // Detect shell by command field presence OR tool name pattern
  const hasCommand = Boolean(toolData.command || toolData.input?.command)
  const isShell = hasCommand || nameLower.includes("shell") || nameLower.includes("bash") || nameLower.includes("exec")
  const { label } = isShell ? { label: "Bash" } : getToolIcon(toolName)
  const summary = isShell ? getToolSummary("bash", toolData) : getToolSummary(toolName, toolData)
  const isEdit = nameLower.includes("edit")
  const isWrite = nameLower.includes("write") || isEdit
  const isRead = nameLower.includes("read")
  const isGrep = nameLower.includes("grep")
  const hasEditDiff = isEdit && editStrings !== null

  return (
    <div
      className="overflow-hidden rounded-md border border-border bg-muted"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        className="flex w-full min-w-0 items-center gap-2 overflow-hidden bg-muted px-3 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
      >
        <StatusIndicator status={status} />
        <svg className="h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {isShell ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
          ) : isWrite ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
          ) : isRead ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
          ) : isGrep ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z" />
          )}
        </svg>
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {summary ? (
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ellipsis text-left font-mono text-xs text-foreground">{summary}</span>
        ) : (
          <span className="flex-1" />
        )}
        {diffStats && (
          <span className="shrink-0 font-mono text-2xs">
            <span className="text-diff-add">+{diffStats.additions}</span>
            {" "}
            <span className="text-diff-remove">-{diffStats.deletions}</span>
          </span>
        )}
        {isWrite && !hasEditDiff && (
          <span className="shrink-0 rounded bg-amber-100 dark:bg-amber-900/20 px-1.5 py-0.5 text-2xs font-medium text-amber-600 dark:text-amber-400">modified</span>
        )}
        {/* Hover expand icon */}
        <span className={`shrink-0 text-muted-foreground transition-opacity ${hovered ? "opacity-100" : "opacity-0"}`}>
          {expanded ? (
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
            </svg>
          ) : (
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          )}
        </span>
      </button>

      {/* Expanded content with smooth animation */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border p-3">
            {toolData.command && (
              <div className="mb-2">
                <pre className="overflow-x-auto rounded bg-background/50 p-2 font-mono text-xxs leading-[1.6] text-foreground">
                  $ {toolData.command}
                </pre>
              </div>
            )}

            {toolData.output && (
              <pre className="max-h-48 overflow-auto rounded bg-background/50 p-2 font-mono text-xxs leading-[1.6] text-muted-foreground">
                {toolData.output}
              </pre>
            )}

            {hasEditDiff && editStrings && (
              <DiffViewer
                oldString={editStrings.oldString}
                newString={editStrings.newString}
                filePath={editStrings.filePath}
                className="overflow-x-auto rounded bg-background/50 text-xxs"
              />
            )}

            {toolData.diff && !hasEditDiff && (
              <pre className="overflow-x-auto rounded bg-background/50 p-2 font-mono text-xxs leading-[1.6]">
                {toolData.diff.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith("+")
                        ? "text-diff-add"
                        : line.startsWith("-")
                          ? "text-diff-remove"
                          : "text-muted-foreground"
                    }
                  >
                    {line}
                  </div>
                ))}
              </pre>
            )}

            {toolData.input && !toolData.command && !toolData.diff && !hasEditDiff && (
              <pre className="overflow-x-auto rounded bg-background/50 p-2 font-mono text-xxs leading-[1.6] text-muted-foreground">
                {JSON.stringify(toolData.input, null, 2)}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
