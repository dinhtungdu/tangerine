/**
 * Strips system-injected content from user messages.
 * When syncing from ACP (TUI mode), user messages include Tangerine system context
 * that shouldn't be displayed in the Chat UI.
 */
export function stripSystemContent(content: string): string {
  let result = content

  // Remove bracketed system notes: [TANGERINE: ...], [AUTH: ...], etc.
  // These can span multiple lines, so we match until the closing bracket.
  const bracketPatterns = [
    /\[TANGERINE:[^\]]*\]/g,
    /\[AUTH:[^\]]*\]/g,
    /\[PR MODE[^\]]*\]/g,
    /\[NOTE:[^\]]*\]/g,
    /\[STYLE:[^\]]*\]/g,
    /\[CONTEXT:[^\]]*\]/g,
    /\[RUNNER TASK:[^\]]*\]/g,
    /\[PR TEMPLATE:[^\]]*\]/g,
  ]

  for (const pattern of bracketPatterns) {
    result = result.replace(pattern, "")
  }

  // Remove XML-style system tags (can span multiple lines)
  result = result.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
  result = result.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
  result = result.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
  result = result.replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
  result = result.replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
  result = result.replace(/<command-args>[\s\S]*?<\/command-args>/g, "")

  // Trim leading/trailing whitespace and collapse multiple newlines
  result = result.trim().replace(/\n{3,}/g, "\n\n")

  return result
}
