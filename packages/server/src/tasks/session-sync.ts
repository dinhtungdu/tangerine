import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import type { AppConfig } from "../config"
import { getRepoDir } from "../config"
import type { AgentFactories } from "../agent/factories"
import { getAgentHandleMeta } from "../agent/provider"
import type { AgentEvent, AgentHandle } from "../agent/provider"
import { DbError, SessionStartError, TaskNotFoundError } from "../errors"
import { getTask, insertSessionLog, updateTask } from "../db/queries"

export interface ConversationSyncResult {
  available: boolean
  inserted: number
  skipped: number
  reason?: "missing-session-id" | "history-load-unsupported"
}

export interface ConversationSyncDeps {
  db: Database
  config: AppConfig
  agentFactories: AgentFactories
  getAgentHandle(taskId: string): AgentHandle | null
}

interface SyncLogEntry {
  role: "user" | "assistant" | "thinking" | "content" | "plan"
  content: string
  messageId?: string | null
}

export function syncConversationFromAcp(
  deps: ConversationSyncDeps,
  taskId: string,
): Effect.Effect<ConversationSyncResult, TaskNotFoundError | DbError | SessionStartError> {
  return Effect.gen(function* () {
    const task = yield* getTask(deps.db, taskId)
    if (!task) return yield* Effect.fail(new TaskNotFoundError({ taskId }))

    const handle = deps.getAgentHandle(taskId)
    const liveSessionId = handle ? getAgentHandleMeta(handle)?.sessionId ?? null : null
    const sessionId = task.agent_session_id ?? liveSessionId
    if (!sessionId) return { available: false, inserted: 0, skipped: 0, reason: "missing-session-id" }

    if (!task.agent_session_id && liveSessionId) {
      yield* updateTask(deps.db, taskId, { agent_session_id: liveSessionId }).pipe(Effect.asVoid)
    }

    const factory = deps.agentFactories[task.provider]
    if (!factory?.loadSessionHistory) {
      return { available: false, inserted: 0, skipped: 0, reason: "history-load-unsupported" }
    }

    const workdir = task.worktree_path ?? getRepoDir(deps.config.config, task.project_id)
    const events = yield* factory.loadSessionHistory({
      taskId,
      workdir,
      sessionId,
      env: {
        TANGERINE_TASK_ID: taskId,
        ...(deps.config.credentials.tangerineAuthToken ? { TANGERINE_AUTH_TOKEN: deps.config.credentials.tangerineAuthToken } : {}),
      },
    })

    const existingSyncState = loadExistingSyncState(deps.db, taskId)
    let inserted = 0
    let skipped = 0
    for (const event of events) {
      const entry = syncLogEntryFromEvent(event)
      if (!entry) continue
      const messageKey = syncMessageKey(entry)
      if (messageKey && existingSyncState.messageKeys.has(messageKey)) {
        skipped += 1
        continue
      }
      if (messageKey && backfillChatAuthoredUserPrompt(deps.db, existingSyncState, entry)) {
        existingSyncState.messageKeys.add(messageKey)
        skipped += 1
        continue
      }
      yield* insertSessionLog(deps.db, {
        task_id: taskId,
        role: entry.role,
        content: entry.content,
        message_id: entry.messageId ?? null,
      })
      if (messageKey) existingSyncState.messageKeys.add(messageKey)
      inserted += 1
    }

    return { available: true, inserted, skipped }
  })
}

function syncLogEntryFromEvent(event: AgentEvent): SyncLogEntry | null {
  switch (event.kind) {
    case "message.complete":
      return { role: event.role, content: event.content, messageId: event.messageId ?? null }
    case "thinking":
    case "thinking.complete":
      return { role: "thinking", content: event.content, messageId: event.kind === "thinking.complete" ? event.messageId ?? null : null }
    case "content.block":
      return { role: "content", content: JSON.stringify(event.block) }
    case "plan":
      return { role: "plan", content: JSON.stringify(event.entries) }
    default:
      return null
  }
}

function syncMessageKey(entry: SyncLogEntry): string | null {
  const messageId = entry.messageId?.trim()
  return messageId ? `${entry.role}:${messageId}` : null
}

interface ExistingSyncState {
  messageKeys: Set<string>
  chatAuthoredUserPrompts: Map<string, Array<{ id: number }>>
}

function loadExistingSyncState(db: Database, taskId: string): ExistingSyncState {
  const rows = db.prepare("SELECT id, role, content, message_id FROM session_logs WHERE task_id = ? ORDER BY id ASC")
    .all(taskId) as Array<{ id: number; role: string; content: string; message_id: string | null }>
  const messageKeys = new Set<string>()
  const chatAuthoredUserPrompts = new Map<string, Array<{ id: number }>>()
  for (const row of rows) {
    const messageId = row.message_id?.trim()
    if (messageId) {
      messageKeys.add(`${row.role}:${messageId}`)
      continue
    }
    if (row.role !== "user") continue
    const prompts = chatAuthoredUserPrompts.get(row.content) ?? []
    prompts.push({ id: row.id })
    chatAuthoredUserPrompts.set(row.content, prompts)
  }
  return { messageKeys, chatAuthoredUserPrompts }
}

function backfillChatAuthoredUserPrompt(db: Database, state: ExistingSyncState, entry: SyncLogEntry): boolean {
  const messageId = entry.messageId?.trim()
  if (entry.role !== "user" || !messageId) return false
  const matches = state.chatAuthoredUserPrompts.get(entry.content)
  const match = matches?.shift()
  if (!match) return false
  if (matches && matches.length === 0) state.chatAuthoredUserPrompts.delete(entry.content)
  db.prepare("UPDATE session_logs SET message_id = ? WHERE id = ? AND message_id IS NULL").run(messageId, match.id)
  return true
}
