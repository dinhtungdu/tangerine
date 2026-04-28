import { lazy, Suspense } from "react"
import { Routes, Route } from "react-router-dom"
import { Layout } from "./components/Layout"
import { AuthGate } from "./components/AuthGate"
import { AuthProvider } from "./context/AuthContext"
import { ProjectProvider } from "./context/ProjectContext"

const RunsPage = lazy(() => import("./pages/RunsPage").then((m) => ({ default: m.RunsPage })))
const TaskDetail = lazy(() => import("./pages/TaskDetail").then((m) => ({ default: m.TaskDetail })))
const CronsPage = lazy(() => import("./pages/CronsPage").then((m) => ({ default: m.CronsPage })))
const StatusPage = lazy(() => import("./pages/StatusPage").then((m) => ({ default: m.StatusPage })))

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <ProjectProvider>
          <Suspense>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<RunsPage />} />
                <Route path="crons" element={<CronsPage />} />
                <Route path="status" element={<StatusPage />} />
                <Route path="tasks/:id" element={<TaskDetail />} />
              </Route>
            </Routes>
          </Suspense>
        </ProjectProvider>
      </AuthGate>
    </AuthProvider>
  )
}
