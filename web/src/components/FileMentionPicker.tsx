import { FileText } from "lucide-react"
import type { FileMention } from "../hooks/useFileMentionPicker"
import { SuggestionPicker } from "./SuggestionPicker"

interface FileMentionPickerProps {
  files: FileMention[]
  selectedIndex: number
  onSelect: (file: FileMention) => void
  onHover: (index: number) => void
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path
}

function fileDir(path: string): string {
  const idx = path.lastIndexOf("/")
  return idx === -1 ? "" : path.slice(0, idx)
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
      {(file) => (
        <>
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{fileName(file.path)}</span>
          <span className="hidden min-w-0 max-w-[50%] truncate font-mono text-xxs text-muted-foreground md:inline">
            {fileDir(file.path)}
          </span>
        </>
      )}
    </SuggestionPicker>
  )
}
