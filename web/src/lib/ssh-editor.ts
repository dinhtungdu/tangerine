export type EditorType = "vscode" | "cursor" | "zed"

export const EDITOR_NAMES: Record<EditorType, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
}

export function buildSshEditorUri(
  editor: EditorType,
  host: string,
  worktreePath: string,
  user?: string,
): string {
  switch (editor) {
    case "vscode":
      return `vscode://vscode-remote/ssh-remote+${host}${worktreePath}`
    case "cursor":
      return `cursor://vscode-remote/ssh-remote+${host}${worktreePath}`
    case "zed":
      // Zed requires username in the URI
      if (user) {
        return `zed://ssh/${user}@${host}${worktreePath}`
      }
      return `zed://ssh/${host}${worktreePath}`
  }
}
