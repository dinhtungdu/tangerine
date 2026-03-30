// Bridge between Effect programs and Hono HTTP responses.
// Routes call runEffect/runEffectVoid to unwrap Effect at the HTTP boundary,
// mapping tagged errors to appropriate status codes automatically.

import { Effect, Exit, Cause, Option } from "effect"
import type { Context as HonoContext } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

const DEFAULT_ERROR_MAP: Record<string, number> = {
  TaskNotFoundError: 404,
  VmNotFoundError: 404,
  ProjectNotFoundError: 404,
  ProjectExistsError: 409,
  ConfigValidationError: 400,
  TaskNotTerminalError: 400,
  PrCapabilityError: 400,
  PoolExhaustedError: 503,
  AgentError: 502,
  AgentConnectionError: 502,
}

/**
 * Runs an Effect and returns a JSON response, mapping tagged errors to HTTP status codes.
 * Use for GET routes and POST routes that return data.
 */
export function runEffect<A, E>(
  c: HonoContext,
  effect: Effect.Effect<A, E>,
  options?: {
    status?: number
    errorMap?: Record<string, number>
  }
): Promise<Response> {
  const errorMap = { ...DEFAULT_ERROR_MAP, ...options?.errorMap }

  return Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return c.json(exit.value as object, (options?.status ?? 200) as ContentfulStatusCode)
    }

    const failure = Cause.failureOption(exit.cause)
    if (Option.isSome(failure)) {
      const error = failure.value as Record<string, unknown>
      const tag = typeof error._tag === "string" ? error._tag : undefined
      const message = typeof error.message === "string" ? error.message : (tag ?? "Unknown error")
      const status = (tag ? (errorMap[tag] ?? 500) : 500) as ContentfulStatusCode
      return c.json({ error: message }, status)
    }

    // Defect (unexpected throw or die) — don't leak internals
    return c.json({ error: "Internal server error" }, 500 as ContentfulStatusCode)
  })
}

/**
 * Runs a void Effect and returns { ok: true } on success.
 * Use for POST action routes (cancel, abort, etc.) that don't return data.
 */
export function runEffectVoid<E>(
  c: HonoContext,
  effect: Effect.Effect<void, E>,
  options?: {
    status?: number
    errorMap?: Record<string, number>
  }
): Promise<Response> {
  return runEffect(
    c,
    Effect.map(effect, () => ({ ok: true as const })),
    options
  )
}
