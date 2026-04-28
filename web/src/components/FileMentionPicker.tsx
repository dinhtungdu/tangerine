import { FileText } from "lucide-react"
import type { FileMention } from "../hooks/useFileMentionPicker"
import { SuggestionPicker } from "./SuggestionPicker"

interface FileMentionPickerProps {
  files: FileMention[]
  selectedIndex: number
  onSelect: (file: FileMention) => void
  onHover: (index: number) => void
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/")
  if (idx === -1) return { dir: "", name: path }
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) }
}

export function FileMentionPicker({ files, selectedIndex, onSelect, onHover }: FileMentionPickerProps) {
  return (
    <SuggestionPicker
      items={files}
      selectedIndex={selectedIndex}
      getKey={(file) => file.path}
      onSelect={onSelect}
      onHover={onHover}
    >
      {(file) => {
        const { dir, name } = splitPath(file.path)
        return (
          <>
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm"
              dir="rtl"
            >
              <bdi>
                <span className="text-muted-foreground">{dir}</span>
                <span className="font-semibold text-foreground">{name}</span>
              </bdi>
            </span>
          </>
        )
      }}
    </SuggestionPicker>
  )
}
