export interface TriggerToken {
  triggerStart: number
  query: string
}

export function findTriggerToken(
  text: string,
  cursorPos: number,
  trigger: string,
  boundary: "whitespace" | "line-start" = "whitespace",
): TriggerToken | null {
  let i = cursorPos - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === trigger) {
      if (boundary === "line-start") {
        if (i > 0 && text[i - 1] !== "\n") return null
      } else if (i > 0 && text[i - 1] !== " " && text[i - 1] !== "\n") return null
      const query = text.slice(i + 1, cursorPos)
      if (query.includes("\n") || query.includes(" ")) return null
      return { triggerStart: i, query }
    }
    if (ch === " " || ch === "\n") break
    i--
  }
  return null
}
