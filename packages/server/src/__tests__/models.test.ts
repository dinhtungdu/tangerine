import { describe, test, expect } from "bun:test"
import { discoverModels, discoverClaudeCodeModels, discoverModelsByProvider } from "../models"

describe("discoverModels", () => {
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

describe("discoverModelsByProvider", () => {
  test("returns models grouped by provider type", () => {
    const result = discoverModelsByProvider()
    expect(result).toHaveProperty("opencode")
    expect(result).toHaveProperty("claude-code")
    expect(Array.isArray(result.opencode)).toBe(true)
    expect(Array.isArray(result["claude-code"])).toBe(true)
  })

  test("claude-code models match discoverClaudeCodeModels", () => {
    const byProvider = discoverModelsByProvider()
    const direct = discoverClaudeCodeModels()
    expect(byProvider["claude-code"]).toEqual(direct)
  })
})
