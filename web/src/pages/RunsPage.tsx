import { useProjectNav } from "../hooks/useProjectNav"

export function RunsPage() {
  const { navigate } = useProjectNav()

  return (
    <div className="hidden h-full flex-col items-center justify-center md:flex">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-secondary">
          <svg className="h-6 w-6 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
          </svg>
        </div>
        <div>
          <p className="text-[14px] font-medium text-fg">Select a task from the sidebar</p>
          <p className="mt-1 text-[13px] text-fg-muted">or create a new agent to get started</p>
        </div>
        <button
          onClick={() => navigate("/new")}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-surface-dark px-4 text-white"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="text-[13px] font-medium">New Agent</span>
        </button>
      </div>
    </div>
  )
}
