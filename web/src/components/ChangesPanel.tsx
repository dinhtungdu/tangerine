import type { DiffFile } from "../lib/api"
import { getFileStats, fileName, fileDir } from "./DiffView"

export interface DiffComment {
  id: string
  filePath: string
  lineRef: string
  side: "left" | "right"
  text: string
}

interface ChangesPanelProps {
  files: DiffFile[]
  comments: DiffComment[]
  onRemoveComment?: (id: string) => void
  onSendComments?: (comments: DiffComment[]) => void
  onScrollToFile?: (path: string) => void
}

export function ChangesPanel({ files, comments, onRemoveComment, onSendComments, onScrollToFile }: ChangesPanelProps) {
  const handleSendAll = () => {
    if (comments.length === 0) return
    onSendComments?.(comments)
  }

  return (
    <div className="flex h-[180px] w-full shrink-0 flex-col border-t border-edge @min-[700px]/diff:h-full @min-[700px]/diff:w-[220px] @min-[700px]/diff:border-l @min-[700px]/diff:border-t-0">
      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex h-11 items-center justify-between px-3">
          <span className="text-[12px] font-semibold text-fg">Changed Files</span>
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-secondary px-1.5 font-mono text-[10px] font-medium text-fg-muted">
            {files.length}
          </span>
        </div>
        {files.map((file) => {
          const stats = getFileStats(file.diff)
          const fileComments = comments.filter((c) => c.filePath === file.path)
          return (
            <div key={file.path}>
              <button
                onClick={() => onScrollToFile?.(file.path)}
                className="flex w-full items-center gap-2 border-b border-edge px-4 py-2 text-left hover:bg-surface-secondary/50"
              >
                <svg className="h-3.5 w-3.5 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-fg">{fileName(file.path)}</div>
                  <div className="truncate text-[11px] text-fg-muted">{fileDir(file.path)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-green-600">+{stats.added}</span>
                  <span className="text-[11px] font-semibold text-red-500">&minus;{stats.removed}</span>
                </div>
                {fileComments.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-[10px] font-semibold text-surface">
                    {fileComments.length}
                  </span>
                )}
              </button>
              {/* Inline comments for this file */}
              {fileComments.length > 0 && (
                <div className="flex flex-col gap-2 border-b border-edge px-3 py-2">
                  {fileComments.map((comment) => (
                    <div key={comment.id} className="rounded-lg border border-edge bg-surface p-3">
                      <div className="mb-1.5 flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <svg className="h-3 w-3 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                          </svg>
                          <span className="text-[12px] font-medium text-fg">{fileName(comment.filePath)}</span>
                          <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">{comment.lineRef}</span>
                        </div>
                        <button onClick={() => onRemoveComment?.(comment.id)} className="text-fg-faint hover:text-fg-muted">
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                          </svg>
                        </button>
                      </div>
                      <p className="text-[12px] leading-relaxed text-fg-muted">{comment.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer: send comments */}
      <div className="border-t border-edge px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] text-fg-muted">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 0 1-.923 1.785A5.969 5.969 0 0 0 6 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337Z" />
          </svg>
          <span>{comments.length} comment{comments.length !== 1 ? "s" : ""} ready to send</span>
        </div>
        <button
          onClick={handleSendAll}
          disabled={comments.length === 0}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-fg px-4 py-2.5 text-[13px] font-medium text-surface transition hover:bg-fg/90 disabled:opacity-40"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
          </svg>
          Send All to Chat
        </button>
      </div>
    </div>
  )
}
