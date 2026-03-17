import { useState } from "react"

interface ToolCallDisplayProps {
  content: string
}

interface ToolCallData {
  tool?: string
  name?: string
  input?: Record<string, unknown>
  output?: string
  command?: string
  path?: string
  diff?: string
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
  if (name.includes("read") || name.includes("search")) return { icon: "file-search", label: "Read file" }
  if (name.includes("write")) return { icon: "file-pen", label: "Write file" }
  if (name.includes("edit")) return { icon: "file-pen", label: "Edit file" }
  if (name.includes("bash") || name.includes("shell") || name.includes("exec")) return { icon: "terminal", label: "Bash" }
  return { icon: "tool", label: toolName }
}

export function ToolCallDisplay({ content }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  const toolData = parseToolCall(content)

  if (!toolData) {
    return (
      <pre className="overflow-x-auto rounded-md border border-[#e5e5e5] bg-[#f5f5f5] p-2 text-[11px] text-[#737373]">
        {content}
      </pre>
    )
  }

  const toolName = toolData.tool || toolData.name || "Tool Call"
  const { label } = getToolIcon(toolName)
  const isShell = toolName.toLowerCase().includes("shell") || toolName.toLowerCase().includes("bash") || toolName.toLowerCase().includes("exec")
  const isWrite = toolName.toLowerCase().includes("write") || toolName.toLowerCase().includes("edit")

  return (
    <div className="overflow-hidden rounded-md border border-[#e5e5e5] bg-[#f5f5f5]">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        className="flex w-full items-center gap-2 bg-[#f5f5f5] px-3 py-1.5"
      >
        <svg className="h-3.5 w-3.5 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {isShell ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
          ) : isWrite ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          )}
        </svg>
        <span className="text-[12px] font-medium text-[#737373]">{label}</span>
        {toolData.path && (
          <span className="font-mono text-[12px] text-[#0a0a0a]">{toolData.path}</span>
        )}
        {toolData.command && (
          <span className="font-mono text-[12px] text-[#0a0a0a]">{toolData.command}</span>
        )}
        {isWrite && toolData.path && (
          <span className="ml-auto rounded bg-[#fbbf2430] px-1.5 py-0.5 text-[10px] font-medium text-[#d97706]">modified</span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-[#e5e5e5] p-3">
          {toolData.command && (
            <div className="mb-2">
              <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] leading-[1.6] text-[#0a0a0a]">
                $ {toolData.command}
              </pre>
            </div>
          )}

          {toolData.output && (
            <pre className="max-h-48 overflow-auto rounded bg-white p-2 font-mono text-[11px] leading-[1.6] text-[#737373]">
              {toolData.output}
            </pre>
          )}

          {toolData.diff && (
            <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] leading-[1.6]">
              {toolData.diff.split("\n").map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("+")
                      ? "text-green-700"
                      : line.startsWith("-")
                        ? "text-red-600"
                        : "text-[#737373]"
                  }
                >
                  {line}
                </div>
              ))}
            </pre>
          )}

          {toolData.input && !toolData.command && !toolData.diff && (
            <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] leading-[1.6] text-[#737373]">
              {JSON.stringify(toolData.input, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
