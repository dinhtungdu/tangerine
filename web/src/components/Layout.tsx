import { Outlet } from "react-router-dom"
import { Topbar } from "./Topbar"

export function Layout() {
  return (
    <div className="flex h-screen flex-col bg-[#fafafa]">
      <Topbar />
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  )
}
