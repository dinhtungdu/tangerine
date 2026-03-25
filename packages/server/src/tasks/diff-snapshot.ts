// Captures git diff output and stores it in the task row before worktree cleanup.
// Safety net: the branch-based diff is preferred at read time, but if the branch
// is deleted (e.g. after PR merge) the snapshot ensures the diff is still viewable.

import { Effect } from "effect"
import type { TaskRow } from "../db/types"
import { createLogger } from "../logger"

const log = createLogger("diff-snapshot")

interface SnapshotDeps {
  updateTask(taskId: string, updates: Partial<Omit<TaskRow, "id">>): Effect.Effect<TaskRow | null, Error>
  getProjectConfig(projectId: string): { defaultBranch?: string } | undefined
}

export function snapshotDiff(
  task: TaskRow,
  deps: SnapshotDeps,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (!task.worktree_path) return

    const project = deps.getProjectConfig(task.project_id)
    const defaultBranch = project?.defaultBranch ?? "main"

    const raw = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          ["bash", "-c", `git diff origin/${defaultBranch}...HEAD`],
          { cwd: task.worktree_path!, stdout: "pipe", stderr: "pipe" },
        )
        return new Response(proc.stdout).text()
      },
      catch: (e) => new Error(`git diff failed: ${e}`),
    })

    if (!raw.trim()) {
      log.debug("No diff to snapshot", { taskId: task.id })
      return
    }

    yield* deps.updateTask(task.id, { diff_snapshot: raw }).pipe(
      Effect.tap(() => Effect.sync(() => log.info("Diff snapshot saved", { taskId: task.id, bytes: raw.length }))),
    )
  })
}
