/** Activity event styling — maps event names to display config matching Pencil design */

export interface ActivityStyle {
  label: string
  /** Hex color for icon */
  color: string
  /** Hex color with alpha for circle background */
  bg: string
  /** SVG path(s) for 12x12 lucide-style icon */
  iconPaths: string[]
}

const TOOL_STYLES: Record<string, ActivityStyle> = {
  "tool.read": {
    label: "Read file",
    color: "#3b82f6",
    bg: "#3b82f618",
    // lucide file-text
    iconPaths: [
      "M1.5 1.5A1 1 0 0 1 2.5.5h4.59a1 1 0 0 1 .7.29l2.92 2.92a1 1 0 0 1 .29.7V10.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z",
      "M4 6.5h4M4 8.5h4M4 4.5h1",
    ],
  },
  "tool.write": {
    label: "Write file",
    color: "#22c55e",
    bg: "#22c55e18",
    // lucide pencil
    iconPaths: [
      "M8.5.94 11.06 3.5 3.5 11.06.94 8.5zM.5 11.5l.44-2.56L8.5.94",
    ],
  },
  "tool.bash": {
    label: "Bash",
    color: "#8b5cf6",
    bg: "#8b5cf618",
    // lucide terminal
    iconPaths: [
      "M1 3l3 3-3 3M6 9h5",
    ],
  },
  "agent.thinking": {
    label: "Thinking",
    color: "#f59e0b",
    bg: "#f59e0b18",
    // lucide brain (simplified)
    iconPaths: [
      "M6 1a5 5 0 0 1 4.33 7.5A5 5 0 0 1 6 11 5 5 0 0 1 1.67 8.5 5 5 0 0 1 6 1z",
      "M6 1v10",
    ],
  },
  "tool.other": {
    label: "Tool",
    color: "#6b7280",
    bg: "#6b728018",
    iconPaths: [
      "M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z",
    ],
  },
}

// Lifecycle event styles — grouped by phase
const LIFECYCLE_STYLES: Record<string, ActivityStyle> = {
  "task.created": {
    label: "Task created",
    color: "#8b5cf6",
    bg: "#8b5cf618",
    iconPaths: ["M6 1v10M1 6h10"], // plus
  },
  "vm.acquiring": {
    label: "Acquiring VM",
    color: "#6b7280",
    bg: "#6b728018",
    iconPaths: ["M1 3h10v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3z", "M4 1v2M8 1v2"], // server
  },
  "vm.acquired": {
    label: "VM ready",
    color: "#22c55e",
    bg: "#22c55e18",
    iconPaths: ["M1 3h10v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3z", "M4 1v2M8 1v2"],
  },
  "ssh.waiting": {
    label: "Connecting",
    color: "#6b7280",
    bg: "#6b728018",
    iconPaths: ["M1 6h3M8 6h3", "M4 3l2 3-2 3M8 3l-2 3 2 3"], // arrows
  },
  "ssh.ready": {
    label: "Connected",
    color: "#22c55e",
    bg: "#22c55e18",
    iconPaths: ["M2 6l3 3 5-5"], // check
  },
  "creds.injected": {
    label: "Credentials injected",
    color: "#22c55e",
    bg: "#22c55e18",
    iconPaths: ["M4 1v4H1l5 5 5-5H8V1z"], // key/shield simplified
  },
  "creds.missing": {
    label: "Credentials missing",
    color: "#ef4444",
    bg: "#ef444418",
    iconPaths: ["M6 2v5M6 9v1"], // alert
  },
  "repo.cloning": {
    label: "Cloning repo",
    color: "#3b82f6",
    bg: "#3b82f618",
    iconPaths: ["M3 1v10M9 4v7", "M3 4h4a2 2 0 0 1 2 2v0"], // git branch
  },
  "repo.cloned": {
    label: "Repo ready",
    color: "#22c55e",
    bg: "#22c55e18",
    iconPaths: ["M3 1v10M9 4v7", "M3 4h4a2 2 0 0 1 2 2v0"],
  },
  "worktree.creating": {
    label: "Creating worktree",
    color: "#3b82f6",
    bg: "#3b82f618",
    iconPaths: ["M3 1v10M9 4v7", "M3 7h6"],
  },
  "worktree.created": {
    label: "Worktree ready",
    color: "#22c55e",
    bg: "#22c55e18",
    iconPaths: ["M3 1v10M9 4v7", "M3 7h6"],
  },
  "setup.started": {
    label: "Running setup",
    color: "#3b82f6",
    bg: "#3b82f618",
    iconPaths: ["M1 3l3 3-3 3M6 9h5"], // terminal
  },
  "setup.completed": {
    label: "Setup complete",
    color: "#22c55e",
    bg: "#22c55e18",
    iconPaths: ["M2 6l3 3 5-5"], // check
  },
  "agent.starting": {
    label: "Starting agent",
    color: "#8b5cf6",
    bg: "#8b5cf618",
    iconPaths: ["M4 1l7 5-7 5V1z"], // play
  },
  "session.ready": {
    label: "Session ready",
    color: "#22c55e",
    bg: "#22c55e18",
    iconPaths: ["M2 6l3 3 5-5"],
  },
  "session.reconnecting": {
    label: "Reconnecting",
    color: "#f59e0b",
    bg: "#f59e0b18",
    iconPaths: ["M1 6a5 5 0 0 1 9-2M11 6a5 5 0 0 1-9 2"], // refresh
  },
  "session.reconnected": {
    label: "Reconnected",
    color: "#22c55e",
    bg: "#22c55e18",
    iconPaths: ["M2 6l3 3 5-5"],
  },
  "config.changed": {
    label: "Config changed",
    color: "#6b7280",
    bg: "#6b728018",
    iconPaths: ["M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z", "M6 4v4M4 6h4"], // settings
  },
}

const DEFAULT_LIFECYCLE_STYLE: ActivityStyle = {
  label: "",
  color: "#6b7280",
  bg: "#6b728018",
  iconPaths: ["M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z"],
}

/** Get display style for an activity entry based on its event name */
export function getActivityStyle(event: string): ActivityStyle {
  return TOOL_STYLES[event] ?? LIFECYCLE_STYLES[event] ?? DEFAULT_LIFECYCLE_STYLE
}

/** Extract the detail text to show below the label */
export function getActivityDetail(event: string, content: string, metadata: Record<string, unknown> | null): string {
  if (!metadata) return content

  const toolInput = metadata.toolInput as string | undefined

  switch (event) {
    case "tool.read":
    case "tool.write":
    case "tool.read.done":
    case "tool.write.done": {
      // Extract file_path from toolInput JSON
      if (toolInput) {
        try {
          const input = JSON.parse(toolInput)
          return input.file_path ?? input.path ?? input.pattern ?? content
        } catch {
          return toolInput
        }
      }
      return content
    }
    case "tool.bash":
    case "tool.bash.done": {
      if (toolInput) {
        try {
          const input = JSON.parse(toolInput)
          return input.command ?? content
        } catch {
          return toolInput
        }
      }
      return content
    }
    case "agent.thinking":
      return content
    default: {
      // Fallback: try to extract useful detail from toolInput for unclassified tools
      if (toolInput) {
        try {
          const input = JSON.parse(toolInput)
          return input.file_path ?? input.path ?? input.pattern ?? input.command ?? content
        } catch {
          return content
        }
      }
      return content
    }
  }
}
