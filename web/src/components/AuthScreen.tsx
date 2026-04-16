import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

interface AuthScreenProps {
  error?: string | null
  onSubmit: (token: string) => Promise<void>
}

export function AuthScreen({ error, onSubmit }: AuthScreenProps) {
  const [token, setToken] = useState("")
  const [submitting, setSubmitting] = useState(false)

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Unlock Tangerine</CardTitle>
          <CardDescription>Enter the shared `TANGERINE_AUTH_TOKEN` for this server.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault()
              if (!token.trim()) return
              setSubmitting(true)
              await onSubmit(token.trim())
              setSubmitting(false)
            }}
          >
            <Input
              aria-label="Auth token"
              autoComplete="off"
              autoFocus
              placeholder="TANGERINE_AUTH_TOKEN"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button className="w-full" disabled={submitting || !token.trim()} type="submit">
              {submitting ? "Checking..." : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
