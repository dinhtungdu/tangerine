import { Link, useLocation, useSearchParams } from "react-router-dom"
import { ProjectSwitcher } from "./ProjectSwitcher"
import { useTheme } from "../hooks/useTheme"

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark"
  const label = theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System"

  return (
    <button
      onClick={() => setTheme(next)}
      className="flex h-8 items-center gap-1.5 rounded-md px-2 text-fg-muted transition hover:text-fg"
      title={`Theme: ${label}`}
    >
      {theme === "dark" && (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
        </svg>
      )}
      {theme === "light" && (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
        </svg>
      )}
      {theme === "system" && (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />
        </svg>
      )}
    </button>
  )
}

export function Topbar() {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const isRuns = location.pathname === "/" || location.pathname.startsWith("/tasks") || location.pathname === "/new"
  const isStatus = location.pathname === "/status"
  const projectParam = searchParams.get("project")
  const qs = projectParam ? `?project=${encodeURIComponent(projectParam)}` : ""

  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-edge bg-surface px-4">
      {/* Left: Logo + project switcher */}
      <div className="flex items-center gap-4">
        <Link to={`/${qs}`} className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-dark">
            <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
            </svg>
          </div>
          <span className="text-[15px] font-bold text-fg">Tangerine</span>
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
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
              isRuns ? "bg-surface-secondary text-fg" : "text-fg-muted hover:text-fg"
            }`}
          >
            Runs
          </Link>
          <Link
            to={`/status${qs}`}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
              isStatus ? "bg-surface-secondary text-fg" : "text-fg-muted hover:text-fg"
            }`}
          >
            Status
          </Link>
        </nav>
        <div className="h-5 w-px bg-edge" />
        <ThemeToggle />
      </div>
    </header>
  )
}
