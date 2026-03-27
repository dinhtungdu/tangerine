import { Agentation } from "agentation"
import { Routes, Route } from "react-router-dom"
import { Layout } from "./components/Layout"
import { RunsPage } from "./pages/RunsPage"
import { TaskDetail } from "./pages/TaskDetail"
import { NewAgentPage } from "./pages/NewAgentPage"
import { StatusPage } from "./pages/StatusPage"
import { TerminalPage } from "./pages/TerminalPage"
import { ProjectProvider } from "./context/ProjectContext"

export function App() {
  return (
    <ProjectProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<RunsPage />} />
          <Route path="new" element={<NewAgentPage />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="terminal" element={<TerminalPage />} />
          <Route path="tasks/:id" element={<TaskDetail />} />
        </Route>
      </Routes>
      {import.meta.env.DEV && <Agentation endpoint="http://localhost:4747" />}
    </ProjectProvider>
  )
}
