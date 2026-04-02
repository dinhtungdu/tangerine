import { Link, useLocation, useSearchParams } from "react-router-dom"
import { ProjectSwitcher } from "./ProjectSwitcher"

interface TopbarProps {
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
}

export function Topbar({ sidebarOpen, onToggleSidebar }: TopbarProps) {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const isRuns = location.pathname === "/" || location.pathname.startsWith("/tasks")
  const isCrons = location.pathname === "/crons"
  const isStatus = location.pathname === "/status"
  const isSettings = location.pathname === "/settings"
  const projectParam = searchParams.get("project")
  const qs = projectParam ? `?project=${encodeURIComponent(projectParam)}` : ""

  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-edge bg-surface px-4">
      {/* Left: Sidebar toggle + Logo + project switcher */}
      <div className="flex items-center gap-4">
        {onToggleSidebar !== undefined && (
          <button
            onClick={onToggleSidebar}
            className="hidden h-8 w-8 items-center justify-center rounded-md text-fg-muted transition hover:text-fg md:flex"
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path strokeLinecap="round" d="M9 3v18" />
            </svg>
          </button>
        )}
        <Link to={`/${qs}`} className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-dark">
            <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
            </svg>
          </div>
          <span className="text-sub font-bold text-fg">Tangerine</span>
        </Link>

        <div className="h-5 w-px bg-edge" />

        <ProjectSwitcher variant="desktop" />
      </div>

      {/* Center spacer */}
      <div className="flex-1" />

      {/* Right: Nav + theme toggle */}
      <div className="flex items-center gap-2">
        <nav className="flex items-center gap-0.5">
          <Link
            to={`/${qs}`}
            className={`rounded-md px-3 py-1.5 text-md font-medium ${
              isRuns ? "bg-fg text-surface" : "text-fg-muted hover:text-fg"
            }`}
          >
            Runs
          </Link>
          <Link
            to={`/crons${qs}`}
            className={`rounded-md px-3 py-1.5 text-md font-medium ${
              isCrons ? "bg-fg text-surface" : "text-fg-muted hover:text-fg"
            }`}
          >
            Crons
          </Link>
          <Link
            to={`/status${qs}`}
            className={`rounded-md px-3 py-1.5 text-md font-medium ${
              isStatus ? "bg-fg text-surface" : "text-fg-muted hover:text-fg"
            }`}
          >
            Status
          </Link>
        </nav>
        <div className="h-5 w-px bg-edge" />
        <Link
          to={`/settings${qs}`}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition ${
            isSettings ? "text-fg" : "text-fg-muted hover:text-fg"
          }`}
          title="Settings"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a7.723 7.723 0 0 1 0 .255c-.007.38.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </Link>
      </div>
    </header>
  )
}
