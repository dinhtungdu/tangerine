import { Outlet } from "react-router-dom"
import { Topbar } from "./Topbar"

export function Layout() {
  return (
    <div className="flex h-[100dvh] flex-col bg-[#fafafa] md:h-screen">
      {/* Desktop topbar */}
      <div className="hidden shrink-0 md:block">
        <Topbar />
      </div>

      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
