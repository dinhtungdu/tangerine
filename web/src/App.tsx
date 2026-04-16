import { Routes, Route } from "react-router-dom"
import { Layout } from "./components/Layout"
import { AuthGate } from "./components/AuthGate"
import { RunsPage } from "./pages/RunsPage"
import { TaskDetail } from "./pages/TaskDetail"
import { CronsPage } from "./pages/CronsPage"
import { StatusPage } from "./pages/StatusPage"
import { AuthProvider } from "./context/AuthContext"
import { ProjectProvider } from "./context/ProjectContext"

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
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
      </AuthGate>
    </AuthProvider>
  )
}
