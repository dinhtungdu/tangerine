/**
 * Strip a leading "#" from a search query so "#123" matches pr_url paths
 * like "/pull/123". Shared by the SQL LIKE layer and in-memory filters.
 */
export function normalizeSearchQuery(search: string | undefined | null): string | undefined {
  if (!search) return undefined
  return search.startsWith("#") ? search.slice(1) : search
}

/**
 * Escape `%` and `_` in a user-supplied search string so SQLite `LIKE`
 * treats them as literal characters. Caller must append `ESCAPE '\\'` to
 * the LIKE clause so the backslash is recognized as the escape marker.
 * This mirrors the literal-substring semantics used by the in-memory
 * filter in the task-list WebSocket.
 */
export function escapeLikePattern(search: string): string {
  return search.replace(/[\\%_]/g, (c) => `\\${c}`)
}
