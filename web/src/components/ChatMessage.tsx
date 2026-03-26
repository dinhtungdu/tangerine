import { useState } from "react"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { formatTimestamp } from "../lib/format"
import { ToolCallDisplay } from "./ToolCallDisplay"
import { ImageLightbox } from "./ImageLightbox"

interface ChatMessageProps {
  message: ChatMessageType
}

function isToolCall(content: string): boolean {
  if (!content.startsWith("{")) return false
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return "tool" in parsed || "name" in parsed || "command" in parsed
  } catch {
    return false
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function linkifyUrls(text: string): string {
  return escapeHtml(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  )
}

function renderMarkdownTable(block: string): string {
  const rows = block.trim().split("\n")
  if (rows.length < 2) return block

  const parseRow = (row: string) =>
    row.split("|").slice(1, -1).map((cell) => cell.trim())

  const headerRow = rows[0]
  const sepRow = rows[1]
  if (!headerRow || !sepRow) return block

  const headerCells = parseRow(headerRow)
  if (headerCells.length === 0) return block

  // Verify separator row (must be all dashes/colons)
  const sepCells = parseRow(sepRow)
  if (sepCells.length === 0 || !sepCells.every((c) => /^:?-+:?$/.test(c))) return block

  const thClass = "px-3 py-1.5 text-left text-[11px] font-semibold text-fg-muted"
  const tdClass = "px-3 py-1.5 text-[12px]"

  let html = '<div class="my-2 overflow-x-auto rounded-md border border-edge"><table class="w-full border-collapse text-fg">'
  html += "<thead><tr>"
  for (const cell of headerCells) {
    html += `<th class="${thClass}">${cell}</th>`
  }
  html += "</tr></thead><tbody>"

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const cells = parseRow(row)
    if (cells.length === 0) continue
    html += `<tr class="border-t border-edge">`
    for (const cell of cells) {
      html += `<td class="${tdClass}">${cell}</td>`
    }
    html += "</tr>"
  }

  html += "</tbody></table></div>"
  return html
}

function renderMarkdown(text: string): string {
  // Extract code blocks first to protect them from table/inline processing
  const codeBlocks: string[] = []
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    const i = codeBlocks.length
    codeBlocks.push(`<pre class="my-2 rounded-md bg-surface-secondary p-3 font-mono text-[11px] leading-[1.6] overflow-x-auto border border-edge"><code>${code}</code></pre>`)
    return `\x00CODEBLOCK${i}\x00`
  })

  // Render markdown tables before line breaks replace newlines
  processed = processed.replace(
    /(^|\n)(\|.+\|)\n(\|[-:| ]+\|)\n((?:\|.+\|\n?)+)/g,
    (_match, prefix, header, sep, body) => {
      const block = `${header}\n${sep}\n${body}`
      return `${prefix}${renderMarkdownTable(block)}`
    },
  )

  // Render lists (unordered and ordered) — must happen before \n→<br>
  processed = processed.replace(
    /(^|\n)((?:[ ]*[-*][ ]+.+\n?)+)/g,
    (_match, prefix, block) => {
      const items = block.trim().split("\n").map((line: string) => {
        const content = line.replace(/^[ ]*[-*][ ]+/, "")
        return `<li>${content}</li>`
      })
      return `${prefix}<ul class="my-1 ml-4 list-disc space-y-0.5">${items.join("")}</ul>`
    },
  )
  processed = processed.replace(
    /(^|\n)((?:[ ]*\d+\.[ ]+.+\n?)+)/g,
    (_match, prefix, block) => {
      const items = block.trim().split("\n").map((line: string) => {
        const content = line.replace(/^[ ]*\d+\.[ ]+/, "")
        return `<li>${content}</li>`
      })
      return `${prefix}<ol class="my-1 ml-4 list-decimal space-y-0.5">${items.join("")}</ol>`
    },
  )

  // Blockquotes — must happen before \n→<br>
  processed = processed.replace(
    /(^|\n)((?:>[ ]?.+\n?)+)/g,
    (_match, prefix, block) => {
      const content = block.trim().split("\n").map((line: string) => line.replace(/^>[ ]?/, "")).join("<br />")
      return `${prefix}<blockquote class="my-1 border-l-2 border-edge pl-3 text-fg-muted">${content}</blockquote>`
    },
  )

  // Headings — must happen before \n→<br>
  processed = processed
    .replace(/(^|\n)####[ ]+(.+)/g, '$1<h4 class="mt-3 mb-1 text-[13px] font-semibold">$2</h4>')
    .replace(/(^|\n)###[ ]+(.+)/g, '$1<h3 class="mt-3 mb-1 text-[14px] font-semibold">$2</h3>')
    .replace(/(^|\n)##[ ]+(.+)/g, '$1<h2 class="mt-3 mb-1 text-[15px] font-bold">$2</h2>')
    .replace(/(^|\n)#[ ]+(.+)/g, '$1<h1 class="mt-4 mb-1 text-[16px] font-bold">$2</h1>')

  // Horizontal rules
  processed = processed.replace(/(^|\n)---+(\n|$)/g, '$1<hr class="my-2 border-edge" />$2')

  processed = processed
    .replace(/`([^`]+)`/g, '<code class="rounded bg-surface-secondary px-1 py-0.5 font-mono text-[12px] border border-edge">$1</code>')
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer" class="underline text-link hover:text-link-hover break-all">$2</a>')
    .replace(/\n/g, "<br />")

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]!)
  }

  return processed
}

export function ChatMessage({ message }: ChatMessageProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const isUser = message.role === "user"
  const isSystem = message.role === "system"
  const isTool = !isUser && !isSystem && isToolCall(message.content)

  if (isTool) {
    return (
      <div className="animate-fade-in">
        <ToolCallDisplay content={message.content} />
      </div>
    )
  }

  if (isUser) {
    return (
      <div className="animate-fade-in flex justify-end">
        <div className="max-w-[280px] rounded-xl bg-surface-dark px-3.5 py-2.5">
          {message.images && message.images.length > 0 && (
            <>
              <div className="mb-2 flex flex-wrap gap-1">
                {message.images.map((img, i) => (
                  <button key={i} onClick={() => setLightboxIndex(i)} className="cursor-zoom-in">
                    <img
                      src={img.src}
                      alt="Attached image"
                      className="h-16 w-16 rounded-md object-cover"
                    />
                  </button>
                ))}
              </div>
              {lightboxIndex !== null && (
                <ImageLightbox
                  images={message.images}
                  initialIndex={lightboxIndex}
                  onClose={() => setLightboxIndex(null)}
                />
              )}
            </>
          )}
          {message.content && (
            <p
              className="whitespace-pre-wrap text-[13px] leading-[1.5] text-white [&_a]:underline [&_a]:text-link hover:[&_a]:text-link-hover [&_a]:break-all"
              dangerouslySetInnerHTML={{ __html: linkifyUrls(message.content) }}
            />
          )}
          <span className="mt-1 block text-right text-[10px] text-fg-muted/50">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
      </div>
    )
  }

  if (isSystem) {
    return (
      <div className="animate-fade-in flex items-center justify-center gap-2">
        <svg className="h-3 w-3 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0" />
        </svg>
        <span className="text-[11px] text-fg-muted">{message.content}</span>
      </div>
    )
  }

  // Agent message
  return (
    <div className="animate-fade-in flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-[10px] bg-surface-dark">
          <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
          </svg>
        </div>
        <span className="text-[12px] font-semibold text-fg">Agent</span>
        <span className="text-[10px] text-fg-muted/50">{formatTimestamp(message.timestamp)}</span>
      </div>
      <div
        className="text-[13px] leading-[1.6] text-fg"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
      />
    </div>
  )
}
