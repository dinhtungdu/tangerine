import { useState, useEffect, useCallback } from "react"
import type { Cron } from "@tangerine/shared"
import { useProject } from "../context/ProjectContext"
import { useProjectNav } from "../hooks/useProjectNav"
import { ProjectSwitcher } from "../components/ProjectSwitcher"
import { CronForm, CronRow } from "../components/CronList"
import { listCrons, updateCron, deleteCron } from "../lib/api"

export function CronsPage() {
  const { navigate } = useProjectNav()
  const { current, modelsByProvider } = useProject()
  const [crons, setCrons] = useState<Cron[]>([])
  const [loading, setLoading] = useState(true)

  const fetchCrons = useCallback(async () => {
    if (!current) return
    try {
      const data = await listCrons(current.name)
      setCrons(data)
    } finally {
      setLoading(false)
    }
  }, [current])

  useEffect(() => {
    fetchCrons()
  }, [fetchCrons])

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      await updateCron(id, { enabled })
      fetchCrons()
    } catch { /* ignore */ }
  }, [fetchCrons])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteCron(id)
      fetchCrons()
    } catch { /* ignore */ }
  }, [fetchCrons])

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Mobile project switcher */}
      <div className="md:hidden">
        <ProjectSwitcher variant="mobile" />
      </div>

      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-8">
        {/* Header */}
        <div className="mb-6">
          <div className="hidden md:block">
            <h1 className="text-[20px] font-bold text-fg md:text-[24px]">Crons</h1>
            <p className="mt-0.5 text-[13px] text-fg-muted">Recurring tasks on a schedule</p>
          </div>
          {/* Mobile header */}
          <div className="flex items-center gap-3 md:hidden">
            <button onClick={() => navigate("/")} aria-label="Back" className="text-fg">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
              </svg>
            </button>
            <span className="text-[18px] font-semibold text-fg">Crons</span>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          {/* Create form */}
          {current && (
            <CronForm
              projectId={current.name}
              onCreated={fetchCrons}
              modelsByProvider={modelsByProvider}
            />
          )}

          {/* Cron list */}
          <div className="overflow-hidden rounded-lg border border-edge">
            {loading ? (
              <div className="py-12 text-center text-[13px] text-fg-muted">Loading...</div>
            ) : crons.length === 0 ? (
              <div className="py-12 text-center text-[13px] text-fg-muted">No crons configured</div>
            ) : (
              crons.map((c) => (
                <CronRow key={c.id} cron={c} onToggle={handleToggle} onDelete={handleDelete} />
              ))
            )}
          </div>

          {/* Footer */}
          {crons.length > 0 && (
            <div className="text-[12px] text-fg-muted">
              {crons.length} cron{crons.length !== 1 ? "s" : ""} &middot; {crons.filter((c) => c.enabled).length} enabled
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
