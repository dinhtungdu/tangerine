import { describe, test, expect } from "bun:test"
import { discoverModels } from "../models"

describe("discoverModels", () => {
  test("returns models from cache", () => {
    const models = discoverModels()
    // Should return at least some models (opencode provider is always available)
    expect(models.length).toBeGreaterThan(0)
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

  test("includes opencode provider models", () => {
    const models = discoverModels()
    const opencodeModels = models.filter((m) => m.provider === "opencode")
    expect(opencodeModels.length).toBeGreaterThan(0)
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
