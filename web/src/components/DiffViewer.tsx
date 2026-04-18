import { useMemo } from "react"

interface DiffViewerProps {
  oldString: string
  newString: string
  filePath?: string
  className?: string
}

export interface DiffStats {
  additions: number
  deletions: number
  totalLines: number
}

interface DiffLine {
  type: "context" | "add" | "remove"
  content: string
  oldLineNum: number | null
  newLineNum: number | null
}

export function getDiffStats(oldString: string, newString: string): DiffStats {
  const diff = computeDiff(oldString, newString)
  let additions = 0
  let deletions = 0
  for (const line of diff) {
    if (line.type === "add") additions++
    if (line.type === "remove") deletions++
  }
  return {
    additions,
    deletions,
    totalLines: diff.length,
  }
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n")
  const newLines = newStr.split("\n")
  const result: DiffLine[] = []

  let i = 0, j = 0
  let oldNum = 1, newNum = 1

  while (i < oldLines.length || j < newLines.length) {
    const oldLine = oldLines[i] as string | undefined
    const newLine = newLines[j] as string | undefined
    if (i < oldLines.length && j < newLines.length && oldLine === newLine) {
      result.push({ type: "context", content: oldLine!, oldLineNum: oldNum++, newLineNum: newNum++ })
      i++
      j++
    } else {
      const oldInNew = i < oldLines.length && j < newLines.length && newLines.slice(j).includes(oldLines[i]!)
      const newInOld = i < oldLines.length && j < newLines.length && oldLines.slice(i).includes(newLines[j]!)

      if (i < oldLines.length && !oldInNew) {
        result.push({ type: "remove", content: oldLines[i]!, oldLineNum: oldNum++, newLineNum: null })
        i++
      } else if (j < newLines.length && !newInOld) {
        result.push({ type: "add", content: newLines[j]!, oldLineNum: null, newLineNum: newNum++ })
        j++
      } else if (i < oldLines.length) {
        result.push({ type: "remove", content: oldLines[i]!, oldLineNum: oldNum++, newLineNum: null })
        i++
      } else if (j < newLines.length) {
        result.push({ type: "add", content: newLines[j]!, oldLineNum: null, newLineNum: newNum++ })
        j++
      }
    }
  }

  return result
}

export function DiffViewer({ oldString, newString, className }: DiffViewerProps) {
  const diff = useMemo(() => computeDiff(oldString, newString), [oldString, newString])
  const maxLineNum = Math.max(
    ...diff.map((l) => Math.max(l.oldLineNum ?? 0, l.newLineNum ?? 0))
  )
  const gutterWidth = String(maxLineNum).length

  return (
    <div className={`overflow-x-auto rounded bg-background/50 ${className || ""}`}>
      <table className="w-full border-collapse font-mono text-xxs leading-[1.6]">
        <tbody>
          {diff.map((line, idx) => (
            <tr
              key={idx}
              className={
                line.type === "add"
                  ? "bg-green-500/10"
                  : line.type === "remove"
                    ? "bg-red-500/10"
                    : ""
              }
            >
              <td
                className="select-none border-r border-border px-1.5 text-right text-muted-foreground/50"
                style={{ width: `${gutterWidth + 1}ch` }}
              >
                {line.oldLineNum ?? ""}
              </td>
              <td
                className="select-none border-r border-border px-1.5 text-right text-muted-foreground/50"
                style={{ width: `${gutterWidth + 1}ch` }}
              >
                {line.newLineNum ?? ""}
              </td>
              <td className="w-4 select-none px-1 text-center">
                {line.type === "add" ? (
                  <span className="text-diff-add">+</span>
                ) : line.type === "remove" ? (
                  <span className="text-diff-remove">-</span>
                ) : (
                  <span className="text-muted-foreground/30">&nbsp;</span>
                )}
              </td>
              <td
                className={`whitespace-pre px-2 ${
                  line.type === "add"
                    ? "text-diff-add"
                    : line.type === "remove"
                      ? "text-diff-remove"
                      : "text-muted-foreground"
                }`}
              >
                {line.content}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
