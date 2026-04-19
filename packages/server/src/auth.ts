import { timingSafeEqual } from "node:crypto"
import type { Context } from "hono"
import type { AppConfig } from "./config"

export const INSECURE_NO_AUTH_ENV = "TANGERINE_INSECURE_NO_AUTH"

const PUBLIC_API_PATTERNS = [
  /^\/api\/health$/,
  /^\/api\/auth\/session$/,
  /^\/api\/tasks\/[^/]+\/ws$/,
  /^\/api\/tasks\/[^/]+\/terminal$/,
  /^\/api\/ws\/tasks$/,
]

export function isAuthEnabled(config: AppConfig): boolean {
  return typeof config.credentials.tangerineAuthToken === "string" && config.credentials.tangerineAuthToken.length > 0
}

export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null
  const match = header.trim().match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

export function isValidAuthToken(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false
  const expectedBuf = Buffer.from(expected)
  const providedBuf = Buffer.from(provided)
  if (expectedBuf.length !== providedBuf.length) return false
  return timingSafeEqual(expectedBuf, providedBuf)
}

export function isRequestAuthenticated(c: Context, config: AppConfig): boolean {
  if (!isAuthEnabled(config)) return true
  return isValidAuthToken(config.credentials.tangerineAuthToken!, parseBearerToken(c.req.header("authorization")))
}

export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PATTERNS.some((pattern) => pattern.test(path))
}

export function buildUnauthorizedResponse(c: Context): Response {
  const res = c.json({ error: "Unauthorized" }, 401)
  res.headers.set("WWW-Authenticate", 'Bearer realm="Tangerine"')
  return res
}

export function buildAuthSession(c: Context, config: AppConfig): { enabled: boolean; authenticated: boolean } {
  const enabled = isAuthEnabled(config)
  return {
    enabled,
    authenticated: enabled ? isRequestAuthenticated(c, config) : true,
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  const unbracketed = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized

  if (unbracketed === "localhost" || unbracketed === "::1" || unbracketed === "0:0:0:0:0:0:0:1") {
    return true
  }

  const octets = unbracketed.split(".")
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d+$/.test(octet) && Number.parseInt(octet, 10) <= 255)
}

export function getStartupAuthError(config: AppConfig, hostname: string): string | null {
  if (isAuthEnabled(config) || isLoopbackHost(hostname) || process.env[INSECURE_NO_AUTH_ENV] === "1") {
    return null
  }
  return `Refusing to bind ${hostname} without TANGERINE_AUTH_TOKEN. Set TANGERINE_AUTH_TOKEN or ${INSECURE_NO_AUTH_ENV}=1 to acknowledge insecure remote access.`
}

export function getStartupAuthWarning(config: AppConfig, hostname: string): string | null {
  if (!isAuthEnabled(config) && !isLoopbackHost(hostname) && process.env[INSECURE_NO_AUTH_ENV] === "1") {
    return `Starting without auth on ${hostname} because ${INSECURE_NO_AUTH_ENV}=1`
  }
  return null
}
