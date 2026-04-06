import { Routes, Route } from "react-router-dom"
import { Layout } from "./components/Layout"
import { RunsPage } from "./pages/RunsPage"
import { TaskDetail } from "./pages/TaskDetail"
import { CronsPage } from "./pages/CronsPage"
import { StatusPage } from "./pages/StatusPage"
import { ProjectProvider } from "./context/ProjectContext"

export function App() {
  return (
    <ProjectProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<RunsPage />} />
          <Route path="crons" element={<CronsPage />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="tasks/:id" element={<TaskDetail />} />
        </Route>
      </Routes>

    </ProjectProvider>
  )
}
