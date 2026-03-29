import { describe, test, expect } from "bun:test"
import { discoverModels, discoverClaudeCodeModels, discoverModelsByProvider, discoverCodexModels } from "../models"
import { discoverModels as discoverOpenCodeModels } from "../agent/opencode-provider"
import { discoverModels as discoverCodexProviderModels } from "../agent/codex-provider"

describe("discoverModels (opencode)", () => {
  test("returns array (empty if no opencode cache)", () => {
    const models = discoverModels()
    expect(Array.isArray(models)).toBe(true)
  })

  test("each model has required fields", () => {
    const models = discoverModels()
    for (const model of models) {
      expect(model.id).toBeTruthy()
      expect(model.id).toContain("/")
      expect(model.provider).toBeTruthy()
      expect(model.name).toBeTruthy()
    }
  })

  test("model id format is provider/model", () => {
    const models = discoverModels()
    for (const model of models) {
      const parts = model.id.split("/")
      expect(parts.length).toBeGreaterThanOrEqual(2)
      expect(parts[0]).toBe(model.provider)
    }
  })

  test("delegates to opencode-provider discoverModels", () => {
    expect(discoverModels()).toEqual(discoverOpenCodeModels())
  })
})

describe("discoverClaudeCodeModels", () => {
  test("always returns known claude models", () => {
    const models = discoverClaudeCodeModels()
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect(model.id).toMatch(/^claude-/)
      expect(model.provider).toBe("anthropic")
      expect(model.name).toBeTruthy()
    }
  })

  test("includes known claude models", () => {
    const models = discoverClaudeCodeModels()
    const ids = models.map((m) => m.id)
    expect(ids).toContain("claude-opus-4-6")
    expect(ids).toContain("claude-sonnet-4-6")
    expect(ids).toContain("claude-haiku-4-5")
  })
})

describe("discoverCodexModels", () => {
  test("returns array (empty if no codex cache)", () => {
    const models = discoverCodexModels()
    expect(Array.isArray(models)).toBe(true)
  })

  test("delegates to codex-provider discoverModels", () => {
    expect(discoverCodexModels()).toEqual(discoverCodexProviderModels())
  })
})

describe("discoverModelsByProvider", () => {
  test("returns models grouped by provider type", () => {
    const result = discoverModelsByProvider()
    expect(result).toHaveProperty("opencode")
    expect(result).toHaveProperty("claude-code")
    expect(result).toHaveProperty("codex")
    expect(Array.isArray(result.opencode)).toBe(true)
    expect(Array.isArray(result["claude-code"])).toBe(true)
    expect(Array.isArray(result.codex)).toBe(true)
  })

  test("claude-code models match discoverClaudeCodeModels", () => {
    const byProvider = discoverModelsByProvider()
    const direct = discoverClaudeCodeModels()
    expect(byProvider["claude-code"]).toEqual(direct)
  })

  test("opencode models match opencode-provider discoverModels", () => {
    const byProvider = discoverModelsByProvider()
    expect(byProvider.opencode).toEqual(discoverOpenCodeModels())
  })

  test("codex models match codex-provider discoverModels", () => {
    const byProvider = discoverModelsByProvider()
    expect(byProvider.codex).toEqual(discoverCodexProviderModels())
  })
})

describe("opencode-provider discoverModels", () => {
  test("returns array", () => {
    expect(Array.isArray(discoverOpenCodeModels())).toBe(true)
  })

  test("each model has required fields", () => {
    for (const model of discoverOpenCodeModels()) {
      expect(model.id).toBeTruthy()
      expect(model.provider).toBeTruthy()
      expect(model.name).toBeTruthy()
      expect(model.providerName).toBeTruthy()
    }
  })
})

describe("codex-provider discoverModels", () => {
  test("returns array", () => {
    expect(Array.isArray(discoverCodexProviderModels())).toBe(true)
  })

  test("each model has required fields", () => {
    for (const model of discoverCodexProviderModels()) {
      expect(model.id).toBeTruthy()
      expect(model.provider).toBe("openai")
      expect(model.providerName).toBe("OpenAI")
      expect(model.name).toBeTruthy()
    }
  })
})
