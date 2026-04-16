import { useState } from "react"
import { Link, Outlet, useLocation } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { Topbar } from "./Topbar"
import { CommandPalette } from "./CommandPalette"
import { TasksSidebar } from "./TasksSidebar"
import { useProjectNav } from "../hooks/useProjectNav"
import { useProject } from "../context/ProjectContext"
import { useTaskSearch } from "../hooks/useTaskSearch"
import { useAppActions } from "../hooks/useAppActions"
import { ToastProvider } from "../context/ToastContext"

export interface SidebarContext {
  sidebarOpen: boolean
  tasks: Task[]
  tasksLoading: boolean
  refetch: () => void
}

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const location = useLocation()
  const { link, navigate } = useProjectNav()
  const { projects } = useProject()
  const { query, setQuery, tasks, loading: tasksLoading, refetch } = useTaskSearch()

  // Register all app-wide actions + activate global shortcuts
  useAppActions()

  const isTaskDetail = location.pathname.startsWith("/tasks/")
  const isRoot = location.pathname === "/"
  const isRuns = isRoot || location.pathname.startsWith("/tasks")
  const isStatus = location.pathname === "/status"
  const isCrons = location.pathname === "/crons"

  // Show sidebar on task-related routes (index, task detail, status)
  const hasSidebar = !isCrons

  return (
    <ToastProvider>
    <div className={`flex flex-col bg-background md:h-screen ${isRoot ? "min-h-[100dvh]" : "h-[100dvh]"}`}>
      {/* Desktop topbar */}
      <div className="hidden shrink-0 md:block">
        <Topbar sidebarOpen={sidebarOpen} onToggleSidebar={hasSidebar ? () => setSidebarOpen((o) => !o) : undefined} />
      </div>

      {/* Mobile topbar — hidden on desktop and task detail (which has its own header) */}
      {!isTaskDetail && (
        <div className="shrink-0 md:hidden">
          <div className="flex h-12 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary">
                <svg className="h-3.5 w-3.5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
                </svg>
              </div>
              <span className="text-sub font-bold text-foreground">Tangerine</span>
            </div>
            <nav className="flex items-center gap-0.5">
              <Link
                to={link("/")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${
                  isRuns ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Runs
              </Link>
              <Link
                to={link("/crons")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${
                  isCrons ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Crons
              </Link>
              <Link
                to={link("/status")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${
                  isStatus ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Status
              </Link>
            </nav>
          </div>
        </div>
      )}

      {/* On root: flex-col on mobile (sidebar above, form below), flex-row on desktop */}
      <main className={`flex-1 ${isRoot ? "flex flex-col md:flex-row md:min-h-0 md:overflow-hidden" : "min-h-0 overflow-hidden flex"}`}>
        {/* Sidebar — on root mobile: stacked above form; otherwise full-screen or hidden */}
        {hasSidebar && (
          <div className={`
            ${isTaskDetail || isStatus ? "hidden md:block" : "block"}
            ${isRoot ? "order-1 border-b border-border md:h-auto md:max-h-none md:overflow-hidden md:border-b-0" : "overflow-hidden"}
            transition-[width] duration-200 ease-in-out ${sidebarOpen ? "md:w-[240px]" : "md:w-0"}
          `} inert={sidebarOpen ? undefined : true}>
            <TasksSidebar
              tasks={tasks}
              projects={projects}
              searchQuery={query}
              onSearchChange={setQuery}
              onNewAgent={() => navigate("/#new-agent-textarea")}
              onRefetch={refetch}
            />
          </div>
        )}

        <div className={`min-w-0 flex-1 ${isRoot ? "order-2 md:overflow-hidden" : "overflow-hidden"}`}>
          <Outlet context={{ sidebarOpen, tasks, tasksLoading, refetch } satisfies SidebarContext} />
        </div>
      </main>

      <CommandPalette />
    </div>
    </ToastProvider>
  )
}
