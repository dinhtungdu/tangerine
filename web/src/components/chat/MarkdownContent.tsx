import { memo } from "react"

interface MarkdownContentProps {
  content: string
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
}: MarkdownContentProps) {
  // TODO: Add proper markdown rendering
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
      {content}
    </div>
  )
})
