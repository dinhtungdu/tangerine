import { useState, useEffect, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useTaskSearch } from "../hooks/useTaskSearch"
import { TasksSidebar } from "../components/TasksSidebar"
import { ActiveRunsCard, VmSummaryCard, ImageCard, VmList, BuildLog, SystemLog } from "../components/StatusWidgets"
import { fetchVms, fetchImages, fetchBuildStatus, triggerBaseBuild, destroyVm, type VmInfo, type ImageInfo, type BuildStatus } from "../lib/api"

export function StatusPage() {
  const navigate = useNavigate()
  const { current } = useProject()
  const { query, setQuery, tasks } = useTaskSearch(current?.name)
  const [vms, setVms] = useState<VmInfo[]>([])
  const [images, setImages] = useState<ImageInfo[]>([])
  const [buildStatus, setBuildStatus] = useState<BuildStatus>({ status: "idle" })

  const loadAll = useCallback(async () => {
    const [vmData, imgData, bsData] = await Promise.all([
      fetchVms().catch(() => []),
      fetchImages(current?.name).catch(() => []),
      fetchBuildStatus().catch(() => ({ status: "idle" as const })),
    ])
    setVms(vmData as VmInfo[])
    setImages(imgData as ImageInfo[])
    setBuildStatus(bsData)
  }, [current?.name])

  useEffect(() => {
    loadAll()
    const interval = setInterval(loadAll, 10000)
    return () => clearInterval(interval)
  }, [loadAll])

  const handleRebuildVm = useCallback(async (vmId: string) => {
    const confirmed = window.confirm(
      "Destroy this VM and re-provision from base? Active tasks with pushed branches will be reprovisioned. Unpushed work will be lost.\n\nContinue?"
    )
    if (!confirmed) return
    await destroyVm(vmId).catch(() => {})
    loadAll()
  }, [loadAll])

  const handleBuildBase = useCallback(async () => {
    const confirmed = window.confirm(
      "Rebuild base image? This is a slow operation (~10 min). Existing project VMs are not affected — destroy them manually to re-provision from the new base.\n\nContinue?"
    )
    if (!confirmed) return
    await triggerBaseBuild().catch(() => {})
    const bs = await fetchBuildStatus().catch(() => ({ status: "idle" as const }))
    setBuildStatus(bs)
  }, [])

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <TasksSidebar tasks={tasks} searchQuery={query} onSearchChange={setQuery} onNewAgent={() => navigate("/")} />
      </div>

      {/* Main content */}
      <div className="flex h-full w-full flex-col">
        {/* Mobile header */}
        <div className="flex h-[52px] items-center gap-3 border-b border-edge px-4 md:hidden">
          <button onClick={() => navigate("/")} aria-label="Back" className="text-fg">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </button>
          <span className="text-[18px] font-semibold text-fg">Status</span>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          <div className="flex flex-col gap-4 md:gap-6">
            {/* Title — desktop only */}
            <div className="hidden flex-col gap-1 md:flex">
              <h1 className="text-[24px] font-semibold text-fg">System Status</h1>
              <p className="text-[14px] text-fg-muted">Infrastructure health for the current project</p>
            </div>

            {/* Cards — horizontal on desktop, stacked on mobile */}
            <div className="flex flex-col gap-4 md:flex-row md:gap-4">
              <ActiveRunsCard tasks={tasks} />
              <VmSummaryCard vms={vms} onRebuildVm={handleRebuildVm} />
              <ImageCard image={images[0] ?? null} projectImage={current?.image} buildStatus={buildStatus} onBuildBase={handleBuildBase} />
            </div>

            {/* VM list */}
            <VmList vms={vms} />

            {/* Build log */}
            <BuildLog project={current?.name} buildStatus={buildStatus} />

            {/* System log */}
            <SystemLog />
          </div>
        </div>
      </div>
    </div>
  )
}
