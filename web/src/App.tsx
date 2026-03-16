import { Routes, Route } from "react-router-dom"
import { ProjectProvider } from "./context/ProjectContext"
import { useMobile } from "./hooks/useMobile"
import { Layout } from "./components/Layout"
import { Dashboard } from "./pages/Dashboard"
import { TaskDetail } from "./pages/TaskDetail"
import { MobileLayout } from "./components/mobile/MobileLayout"
import { MobileRuns } from "./components/mobile/MobileRuns"
import { MobileNewAgent } from "./components/mobile/MobileNewAgent"
import { MobileTaskDetail } from "./components/mobile/MobileTaskDetail"

function ResponsiveHome() {
  const isMobile = useMobile()
  return isMobile ? <MobileRuns /> : <Dashboard />
}

function ResponsiveTask() {
  const isMobile = useMobile()
  return isMobile ? <MobileTaskDetail /> : <TaskDetail />
}

function ResponsiveLayout() {
  const isMobile = useMobile()
  return isMobile ? <MobileLayout /> : <Layout />
}

export function App() {
  return (
    <ProjectProvider>
      <Routes>
        <Route element={<ResponsiveLayout />}>
          <Route index element={<ResponsiveHome />} />
          <Route path="new" element={<MobileNewAgent />} />
          <Route path="tasks/:id" element={<ResponsiveTask />} />
        </Route>
      </Routes>
    </ProjectProvider>
  )
}
