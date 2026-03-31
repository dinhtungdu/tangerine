import { useState, useRef, useEffect } from "react"
import { useProject } from "../context/ProjectContext"

const projectColors = [
  "bg-indigo-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500",
  "bg-cyan-500", "bg-violet-500", "bg-orange-500", "bg-teal-500",
]

function getProjectColor(index: number) {
  return projectColors[index % projectColors.length]
}

interface ProjectSwitcherProps {
  /** "desktop" renders inline chip style, "mobile" renders full-width row style */
  variant?: "desktop" | "mobile"
}

export function ProjectSwitcher({ variant = "desktop" }: ProjectSwitcherProps) {
  const { projects, current, switchProject } = useProject()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const currentIndex = current ? projects.indexOf(current) : 0

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  const isMobile = variant === "mobile"

  return (
    <div className="relative" ref={ref}>
      {/* Trigger */}
      <button
        onClick={() => setOpen(!open)}
        className={
          isMobile
            ? "flex h-11 w-full items-center justify-between border-b border-edge px-4"
            : "flex items-center gap-2 rounded-md bg-surface-secondary px-2.5 py-1.5 transition hover:bg-surface"
        }
      >
        <div className="flex items-center gap-2">
          {current ? (
            <>
              <div className={`flex items-center justify-center rounded ${getProjectColor(currentIndex)} ${isMobile ? "h-5 w-5" : "h-[18px] w-[18px]"}`}>
                <span className="font-bold text-white text-2xs">
                  {current.name.charAt(0).toUpperCase()}
                </span>
              </div>
              <span className={`truncate font-medium text-fg ${isMobile ? "text-sm" : "max-w-[180px] text-md"}`}>
                {current.name}
              </span>
            </>
          ) : (
            <span className="text-md text-fg-muted">No projects</span>
          )}
        </div>
        <svg
          className={`h-3.5 w-3.5 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && projects.length > 0 && (
        <div className={`absolute z-50 overflow-hidden rounded-lg border border-edge bg-surface-card shadow-lg ${
          isMobile ? "left-4 right-4 top-full" : "left-0 top-full mt-1 min-w-[220px]"
        }`}>
          {!isMobile && (
            <div className="px-3 py-2">
              <span className="text-xxs font-medium tracking-wider text-fg-muted">PROJECTS</span>
            </div>
          )}
          <div className="max-h-[300px] overflow-y-auto">
            {projects.map((project, i) => {
              const isActive = project.name === current?.name
              return (
                <button
                  key={project.name}
                  onClick={() => {
                    switchProject(project.name)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition ${
                    isActive ? "bg-surface-secondary" : isMobile ? "active:bg-surface" : "hover:bg-surface"
                  }`}
                >
                  <div className={`flex shrink-0 items-center justify-center rounded ${getProjectColor(i)} ${isMobile ? "h-5 w-5" : "h-[22px] w-[22px]"}`}>
                    <span className="font-bold text-white text-2xs">
                      {project.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-md font-medium text-fg">{project.name}</span>
                    <span className="truncate text-xxs text-fg-muted">{project.repo}</span>
                  </div>
                  {isActive && (
                    <svg className="ml-auto h-3.5 w-3.5 shrink-0 text-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
