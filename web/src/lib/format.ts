/** Strip provider prefix (e.g. "anthropic/claude-sonnet-4-20250514" -> "claude-sonnet-4") and date suffix */
export function formatModelName(model: string): string {
  const name = model.includes("/") ? model.split("/").pop()! : model
  // Strip date suffix like -20250514
  return name.replace(/-\d{8}$/, "")
}
