import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AuthScreen } from "./AuthScreen"
import { useAuth } from "../context/AuthContext"

export function AuthGate({ children }: { children: ReactNode }) {
  const { enabled, authenticated, loading, error, login, refreshSession } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Checking access...
      </div>
    )
  }

  if (enabled && !authenticated) {
    return <AuthScreen error={error} onSubmit={login} />
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Connection failed</CardTitle>
            <CardDescription>Could not confirm Tangerine access.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={() => { void refreshSession() }}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}
