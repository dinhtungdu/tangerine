import { useState, useEffect, useCallback, type FormEvent } from "react"
import type { ProjectConfig, ProviderType } from "@tangerine/shared"
import { createTask } from "../lib/api"

interface CreateTaskModalProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
  projects: ProjectConfig[]
  defaultProject?: string
}

export function CreateTaskModal({ open, onClose, onCreated, projects, defaultProject }: CreateTaskModalProps) {
  const [projectId, setProjectId] = useState(defaultProject || "")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [provider, setProvider] = useState<ProviderType>("opencode")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync default project when it changes
  useEffect(() => {
    if (defaultProject) setProjectId(defaultProject)
    else if (projects.length > 0 && !projectId) setProjectId(projects[0]!.name)
  }, [defaultProject, projects, projectId])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [open, onClose])

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      if (!title.trim() || !projectId) return

      setSubmitting(true)
      setError(null)
      try {
        await createTask({
          projectId,
          title: title.trim(),
          description: description.trim() || undefined,
          provider,
        })
        setTitle("")
        setDescription("")
        onCreated()
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create task")
      } finally {
        setSubmitting(false)
      }
    },
    [projectId, title, description, provider, onCreated, onClose],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="mb-4 text-lg font-semibold text-neutral-100">Create Task</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {projects.length > 1 && (
            <div>
              <label htmlFor="project" className="mb-1 block text-xs text-neutral-400">
                Project
              </label>
              <select
                id="project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-tangerine"
              >
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor="title" className="mb-1 block text-xs text-neutral-400">
              Title
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Fix login validation"
              required
              className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-tangerine"
            />
          </div>

          <div>
            <label htmlFor="description" className="mb-1 block text-xs text-neutral-400">
              Description (optional)
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the task..."
              rows={3}
              className="w-full resize-none rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-tangerine"
            />
          </div>

          <div>
            <label htmlFor="provider" className="mb-1 block text-xs text-neutral-400">
              Provider
            </label>
            <select
              id="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderType)}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-tangerine"
            >
              <option value="opencode">OpenCode</option>
              <option value="claude-code">Claude Code</option>
            </select>
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-neutral-400 transition hover:text-neutral-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim() || !projectId}
              className="rounded-lg bg-tangerine px-4 py-2 text-sm font-medium text-white transition hover:bg-tangerine-light disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
