import { Link, useLocation } from "react-router-dom"

export function Topbar() {
  const location = useLocation()
  const isRuns = location.pathname === "/" || location.pathname.startsWith("/tasks")
  const isFiles = location.pathname === "/files"
  const isSettings = location.pathname === "/settings"

  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-[#e5e5e5] bg-[#fafafa] px-4">
      {/* Left: Logo + project switcher */}
      <div className="flex items-center gap-4">
        <Link to="/" className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#171717]">
            <svg className="h-3.5 w-3.5 text-[#fafafa]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
            </svg>
          </div>
          <span className="text-[15px] font-bold text-[#0a0a0a]">Tangerine</span>
        </Link>

        <div className="h-5 w-px bg-[#e5e5e5]" />

        {/* Project switcher */}
        <button className="flex items-center gap-2 rounded-md bg-[#f5f5f5] px-2.5 py-1.5">
          <div className="flex h-[18px] w-[18px] items-center justify-center rounded bg-indigo-500">
            <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
            </svg>
          </div>
          <span className="text-[13px] font-medium text-[#0a0a0a]">E-commerce Rewrite</span>
          <svg className="h-3.5 w-3.5 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
          </svg>
        </button>
      </div>

      {/* Center spacer */}
      <div className="flex-1" />

      {/* Right: Nav + actions */}
      <div className="flex items-center gap-2">
        <nav className="flex items-center gap-0.5">
          <Link
            to="/"
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
              isRuns ? "bg-[#f5f5f5] text-[#0a0a0a]" : "text-[#737373] hover:text-[#0a0a0a]"
            }`}
          >
            Runs
          </Link>
          <Link
            to="/files"
            className={`rounded-md px-3 py-1.5 text-[13px] ${
              isFiles ? "bg-[#f5f5f5] font-medium text-[#0a0a0a]" : "text-[#737373] hover:text-[#0a0a0a]"
            }`}
          >
            Files
          </Link>
          <Link
            to="/settings"
            className={`rounded-md px-3 py-1.5 text-[13px] ${
              isSettings ? "bg-[#f5f5f5] font-medium text-[#0a0a0a]" : "text-[#737373] hover:text-[#0a0a0a]"
            }`}
          >
            Settings
          </Link>
        </nav>

        <div className="flex items-center gap-2 ml-4">
          <button className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[#f5f5f5]">
            <svg className="h-4 w-4 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
            </svg>
          </button>
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#171717]">
            <span className="text-[11px] font-semibold text-[#fafafa]">TN</span>
          </div>
        </div>
      </div>
    </header>
  )
}
