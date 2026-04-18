import { describe, test, expect } from "bun:test"
import { createAgentFactories } from "../agent/factories"
import { createClaudeCodeProvider, discoverModels as discoverClaudeCodeModels, toCanonicalId } from "../agent/claude-code-provider"
import { createCodexProvider, discoverModels as discoverCodexProviderModels } from "../agent/codex-provider"
import { createOpenCodeProvider, discoverModels as discoverOpenCodeModels } from "../agent/opencode-provider"
import { buildPiPromptCommand, buildPiSystemPromptCommand, createPiProvider, discoverModels as discoverPiProviderModels, parseContextSize } from "../agent/pi-provider"

const factories = createAgentFactories()

describe("agent factories", () => {
  test("return models grouped by provider", () => {
    expect(Array.isArray(factories.opencode.listModels())).toBe(true)
    expect(Array.isArray(factories["claude-code"].listModels())).toBe(true)
    expect(Array.isArray(factories.codex.listModels())).toBe(true)
    expect(Array.isArray(factories.pi.listModels())).toBe(true)
  })
})

describe("opencode provider listModels", () => {
  test("delegates to provider discovery", () => {
    expect(createOpenCodeProvider().listModels()).toEqual(discoverOpenCodeModels())
  })

  test("each model has required fields", () => {
    for (const model of createOpenCodeProvider().listModels()) {
      expect(model.id).toBeTruthy()
      expect(model.provider).toBeTruthy()
      expect(model.name).toBeTruthy()
      expect(model.providerName).toBeTruthy()
    }
  })
})

describe("claude-code provider listModels", () => {
  test("delegates to discoverModels", () => {
    expect(createClaudeCodeProvider().listModels()).toEqual(discoverClaudeCodeModels())
  })

  test("always includes known Claude models", () => {
    const models = createClaudeCodeProvider().listModels()
    const ids = models.map((m) => m.id)
    expect(ids).toContain("claude-opus-4-7")
    expect(ids).toContain("claude-opus-4-6")
    expect(ids).toContain("claude-opus-4-5-20251101")
    expect(ids).toContain("claude-sonnet-4-6")
    expect(ids).toContain("claude-sonnet-4-5-20250929")
    expect(ids).toContain("claude-haiku-4-5-20251001")
    expect(ids).toContain("claude-3-7-sonnet-20250219")
    expect(ids).toContain("claude-3-5-sonnet-20241022")
    expect(ids).toContain("claude-3-5-haiku-20241022")
  })

  test("each model has a contextWindow", () => {
    for (const model of createClaudeCodeProvider().listModels()) {
      expect(typeof model.contextWindow).toBe("number")
      expect(model.contextWindow).toBeGreaterThan(0)
    }
  })
})

describe("toCanonicalId", () => {
  test("strips date suffixes from versioned API IDs", () => {
    expect(toCanonicalId("claude-opus-4-6-20250514")).toBe("opus-4-6")
    expect(toCanonicalId("claude-sonnet-4-6-20250514")).toBe("sonnet-4-6")
    expect(toCanonicalId("claude-haiku-4-5-20250414")).toBe("haiku-4-5")
  })

  test("returns short IDs unchanged", () => {
    expect(toCanonicalId("opus-4-6")).toBe("opus-4-6")
    expect(toCanonicalId("sonnet-4-6")).toBe("sonnet-4-6")
  })

  test("handles older model formats", () => {
    expect(toCanonicalId("claude-3-5-sonnet-20241022")).toBe("sonnet-3-5")
    expect(toCanonicalId("claude-3-opus-20240229")).toBe("opus-3")
  })

  test("is case-insensitive", () => {
    expect(toCanonicalId("Claude-Opus-4-6-20250514")).toBe("opus-4-6")
  })

  test("returns unknown IDs unchanged", () => {
    expect(toCanonicalId("some-other-model")).toBe("some-other-model")
  })

  test("matches most specific pattern first", () => {
    expect(toCanonicalId("claude-opus-4-6-20250514")).toBe("opus-4-6")
    expect(toCanonicalId("claude-opus-4-5-20250101")).toBe("opus-4-5")
    expect(toCanonicalId("claude-opus-4-1-20250101")).toBe("opus-4-1")
  })
})

describe("codex provider listModels", () => {
  test("delegates to provider discovery", () => {
    expect(createCodexProvider().listModels()).toEqual(discoverCodexProviderModels())
  })

  test("each model has required fields", () => {
    for (const model of createCodexProvider().listModels()) {
      expect(model.id).toBeTruthy()
      expect(model.provider).toBe("openai")
      expect(model.providerName).toBe("OpenAI")
      expect(model.name).toBeTruthy()
    }
  })

  test("each model with contextWindow has a positive value", () => {
    for (const model of createCodexProvider().listModels()) {
      if (model.contextWindow !== undefined) {
        expect(model.contextWindow).toBeGreaterThan(0)
      }
    }
  })
})

describe("pi provider listModels", () => {
  test("delegates to provider discovery", () => {
    expect(createPiProvider().listModels()).toEqual(discoverPiProviderModels())
  })

  test("each model has required fields", () => {
    for (const model of createPiProvider().listModels()) {
      expect(model.id).toBeTruthy()
      expect(model.provider).toBeTruthy()
      expect(model.providerName).toBeTruthy()
      expect(model.name).toBeTruthy()
    }
  })

  test("models include contextWindow when available", () => {
    const models = createPiProvider().listModels()
    // pi is available in this env, so at least some models should have contextWindow
    if (models.length > 0) {
      const withWindow = models.filter((m) => m.contextWindow !== undefined)
      expect(withWindow.length).toBeGreaterThan(0)
      for (const m of withWindow) {
        expect(m.contextWindow).toBeGreaterThan(0)
      }
    }
  })
})

describe("pi parseContextSize", () => {
  test("parses K suffix", () => {
    expect(parseContextSize("144K")).toBe(144_000)
    expect(parseContextSize("128K")).toBe(128_000)
    expect(parseContextSize("32K")).toBe(32_000)
  })

  test("parses M suffix", () => {
    expect(parseContextSize("1M")).toBe(1_000_000)
    expect(parseContextSize("2M")).toBe(2_000_000)
  })

  test("parses bare number", () => {
    expect(parseContextSize("8192")).toBe(8192)
  })

  test("returns undefined for invalid input", () => {
    expect(parseContextSize("")).toBeUndefined()
    expect(parseContextSize("yes")).toBeUndefined()
    expect(parseContextSize("-")).toBeUndefined()
  })
})

describe("pi rpc command builders", () => {
  test("builds set_system_prompt rpc command", () => {
    expect(buildPiSystemPromptCommand("be terse")).toEqual({
      type: "set_system_prompt",
      prompt: "be terse",
    })
  })

  test("builds prompt command with images", () => {
    expect(buildPiPromptCommand("hello", [{
      mediaType: "image/png",
      data: "abc123",
    }])).toEqual({
      type: "prompt",
      message: "hello",
      images: [{
        type: "image",
        mimeType: "image/png",
        data: "abc123",
      }],
    })
  })
})
