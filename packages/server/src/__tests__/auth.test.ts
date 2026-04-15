import { afterEach, describe, expect, test } from "bun:test"
import type { AppConfig } from "../config"
import {
  INSECURE_NO_AUTH_ENV,
  getStartupAccessError,
  getStartupAccessWarning,
  isLoopbackAddress,
  isPeerAllowedForRemoteAccess,
  isTailscaleAddress,
  listTailscaleAddresses,
  normalizeIpAddress,
  resolveListenHosts,
} from "../auth"

function createConfig(overrides?: Partial<AppConfig["config"]>, authToken: string | null = null): AppConfig {
  return {
    config: {
      projects: [
        {
          name: "tangerine",
          repo: "dinhtungdu/tangerine",
          defaultBranch: "main",
          setup: "echo ok",
          defaultProvider: "codex",
          prMode: "none",
          archived: false,
        },
      ],
      workspace: "~/tangerine-workspace",
      remoteAccess: "localhost",
      model: "openai/gpt-5.4",
      models: ["openai/gpt-5.4"],
      actionCombos: [],
      ...overrides,
    },
    credentials: {
      opencodeAuthPath: null,
      claudeOauthToken: null,
      anthropicApiKey: null,
      tangerineAuthToken: authToken,
      serverPort: 3456,
      externalHost: "localhost",
    },
  }
}

afterEach(() => {
  delete process.env[INSECURE_NO_AUTH_ENV]
})

describe("auth network access helpers", () => {
  test("normalizes mapped and scoped IPs", () => {
    expect(normalizeIpAddress("::ffff:127.0.0.1")).toBe("127.0.0.1")
    expect(normalizeIpAddress("fd7a:115c:a1e0::1%utun6")).toBe("fd7a:115c:a1e0::1")
  })

  test("detects loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("::1")).toBe(true)
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("192.168.1.5")).toBe(false)
  })

  test("detects Tailscale addresses", () => {
    expect(isTailscaleAddress("100.117.134.73")).toBe(true)
    expect(isTailscaleAddress("::ffff:100.117.134.73")).toBe(true)
    expect(isTailscaleAddress("fd7a:115c:a1e0::6836:8649")).toBe(true)
    expect(isTailscaleAddress("192.168.1.5")).toBe(false)
  })

  test("lists Tailscale interface addresses", () => {
    const addresses = listTailscaleAddresses({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", cidr: "127.0.0.1/8", mac: "00:00:00:00:00:00" }],
      en0: [{ address: "192.168.1.5", family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: "192.168.1.5/24", mac: "00:00:00:00:00:01" }],
      utun6: [
        { address: "fd7a:115c:a1e0::6836:8649", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff::", cidr: "fd7a:115c:a1e0::6836:8649/48", mac: "00:00:00:00:00:00", scopeid: 0 },
        { address: "100.117.134.73", family: "IPv4", internal: false, netmask: "255.255.255.255", cidr: "100.117.134.73/32", mac: "00:00:00:00:00:00" },
      ],
    })

    expect(addresses).toEqual(["100.117.134.73", "fd7a:115c:a1e0::6836:8649"])
  })

  test("resolves listen hosts from remote access mode", () => {
    const tailscaleConfig = createConfig({ remoteAccess: "tailscale" })
    expect(resolveListenHosts(createConfig())).toEqual(["127.0.0.1", "::1"])
    expect(resolveListenHosts(createConfig({ remoteAccess: "lan" }))).toEqual(["0.0.0.0"])
    expect(resolveListenHosts(tailscaleConfig, {
      utun6: [{ address: "100.117.134.73", family: "IPv4", internal: false, netmask: "255.255.255.255", cidr: "100.117.134.73/32", mac: "00:00:00:00:00:00" }],
    })).toEqual(["127.0.0.1", "::1", "100.117.134.73"])
  })

  test("allows only loopback and Tailscale peers in tailscale mode", () => {
    const config = createConfig({ remoteAccess: "tailscale" }, "secret-token")
    expect(isPeerAllowedForRemoteAccess(config, "127.0.0.1")).toBe(true)
    expect(isPeerAllowedForRemoteAccess(config, "100.117.134.73")).toBe(true)
    expect(isPeerAllowedForRemoteAccess(config, "fd7a:115c:a1e0::6836:8649")).toBe(true)
    expect(isPeerAllowedForRemoteAccess(config, "192.168.1.5")).toBe(false)
    expect(isPeerAllowedForRemoteAccess(config, null)).toBe(false)
  })

  test("requires auth for non-localhost remote access modes", () => {
    const tailscaleConfig = createConfig({ remoteAccess: "tailscale" })
    const lanConfig = createConfig({ remoteAccess: "lan" })

    expect(getStartupAccessError(createConfig(), resolveListenHosts(createConfig()))).toBeNull()
    expect(getStartupAccessError(tailscaleConfig, resolveListenHosts(tailscaleConfig, {}))).toContain("active Tailscale IP")
    expect(getStartupAccessError(tailscaleConfig, ["127.0.0.1", "::1", "100.117.134.73"])).toContain("remoteAccess=tailscale")
    expect(getStartupAccessError(lanConfig, resolveListenHosts(lanConfig))).toContain("remoteAccess=lan")
  })

  test("supports explicit insecure override warning", () => {
    process.env[INSECURE_NO_AUTH_ENV] = "1"
    const config = createConfig({ remoteAccess: "tailscale" })

    expect(getStartupAccessError(config, ["127.0.0.1", "::1", "100.117.134.73"])).toBeNull()
    expect(getStartupAccessWarning(config)).toContain("remoteAccess=tailscale")
  })
})
