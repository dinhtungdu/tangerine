import { timingSafeEqual } from "node:crypto"
import { networkInterfaces } from "node:os"
import type { Context } from "hono"
import type { AppConfig } from "./config"

export const INSECURE_NO_AUTH_ENV = "TANGERINE_INSECURE_NO_AUTH"
const LOOPBACK_LISTEN_HOSTS = ["127.0.0.1", "::1"] as const
const REQUEST_PEER_IPS = new WeakMap<Request, string>()

const PUBLIC_API_PATTERNS = [
  /^\/api\/health$/,
  /^\/api\/auth\/session$/,
  /^\/api\/tasks\/[^/]+\/ws$/,
  /^\/api\/tasks\/[^/]+\/terminal$/,
]

type NetworkInterfaces = ReturnType<typeof networkInterfaces>

export function isAuthEnabled(config: AppConfig): boolean {
  return typeof config.credentials.tangerineAuthToken === "string" && config.credentials.tangerineAuthToken.length > 0
}

export function getRemoteAccessMode(config: AppConfig): "localhost" | "tailscale" | "lan" {
  return config.config.remoteAccess ?? "localhost"
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

export function normalizeIpAddress(address: string | null | undefined): string | null {
  if (!address) return null
  let normalized = address.trim().toLowerCase()
  if (!normalized) return null
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1)
  }
  const zoneIndex = normalized.indexOf("%")
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex)
  }
  if (normalized.startsWith("::ffff:")) {
    const mappedV4 = normalized.slice("::ffff:".length)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mappedV4)) {
      return mappedV4
    }
  }
  return normalized
}

function parseIpv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split(".")
  if (parts.length !== 4) return null
  const octets = parts.map((part) => Number.parseInt(part, 10))
  if (octets.some((octet, index) => !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index])) {
    return null
  }
  return octets as [number, number, number, number]
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address)
  if (!normalized) return false
  if (normalized === "::1") return true
  const octets = parseIpv4Octets(normalized)
  return octets ? octets[0] === 127 : false
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeIpAddress(hostname) ?? hostname.trim().toLowerCase()
  return normalized === "localhost" || isLoopbackAddress(normalized)
}

export function isTailscaleAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address)
  if (!normalized) return false
  const octets = parseIpv4Octets(normalized)
  if (octets) {
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
  }
  return normalized === "fd7a:115c:a1e0::" || normalized.startsWith("fd7a:115c:a1e0:")
}

export function listTailscaleAddresses(interfaces: NetworkInterfaces = networkInterfaces()): string[] {
  const addresses = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      const normalized = normalizeIpAddress(entry.address)
      if (normalized && isTailscaleAddress(normalized)) {
        addresses.add(normalized)
      }
    }
  }
  return [...addresses].sort((left, right) => {
    const leftIsV4 = parseIpv4Octets(left) !== null
    const rightIsV4 = parseIpv4Octets(right) !== null
    if (leftIsV4 !== rightIsV4) return leftIsV4 ? -1 : 1
    return left.localeCompare(right)
  })
}

export function resolveListenHosts(config: AppConfig, interfaces: NetworkInterfaces = networkInterfaces()): string[] {
  const mode = getRemoteAccessMode(config)
  if (mode === "lan") return ["0.0.0.0"]
  if (mode === "tailscale") return [...LOOPBACK_LISTEN_HOSTS, ...listTailscaleAddresses(interfaces)]
  return [...LOOPBACK_LISTEN_HOSTS]
}

export function attachRequestPeerIp(req: Request, peerIp: string | null | undefined): void {
  const normalized = normalizeIpAddress(peerIp)
  if (normalized) {
    REQUEST_PEER_IPS.set(req, normalized)
  }
}

export function getRequestPeerIp(req: Request): string | null {
  return REQUEST_PEER_IPS.get(req) ?? normalizeIpAddress(req.headers.get("x-tangerine-peer-ip"))
}

export function isPeerAllowedForRemoteAccess(config: AppConfig, peerIp: string | null | undefined): boolean {
  if (getRemoteAccessMode(config) !== "tailscale") return true
  const normalized = normalizeIpAddress(peerIp)
  if (!normalized) return false
  return isLoopbackAddress(normalized) || isTailscaleAddress(normalized)
}

export function isRequestPeerAllowed(c: Context, config: AppConfig): boolean {
  return isPeerAllowedForRemoteAccess(config, getRequestPeerIp(c.req.raw))
}

export function buildForbiddenResponse(c: Context): Response {
  return c.json({ error: "Forbidden" }, 403)
}

export function getStartupAccessError(config: AppConfig, listenHosts: string[]): string | null {
  const remoteAccess = getRemoteAccessMode(config)
  if (remoteAccess === "tailscale" && !listenHosts.some((host) => isTailscaleAddress(host))) {
    return "remoteAccess=tailscale requires an active Tailscale IP on this machine."
  }
  if (remoteAccess === "localhost" || isAuthEnabled(config) || process.env[INSECURE_NO_AUTH_ENV] === "1") {
    return null
  }
  return `Refusing to start with remoteAccess=${remoteAccess} without TANGERINE_AUTH_TOKEN. Set TANGERINE_AUTH_TOKEN or ${INSECURE_NO_AUTH_ENV}=1 to acknowledge insecure remote access.`
}

export function getStartupAccessWarning(config: AppConfig): string | null {
  const remoteAccess = getRemoteAccessMode(config)
  if (!isAuthEnabled(config) && remoteAccess !== "localhost" && process.env[INSECURE_NO_AUTH_ENV] === "1") {
    return `Starting with remoteAccess=${remoteAccess} without auth because ${INSECURE_NO_AUTH_ENV}=1`
  }
  return null
}
