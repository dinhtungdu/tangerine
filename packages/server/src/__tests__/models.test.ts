import { describe, test, expect } from "bun:test"
import { createAgentFactories } from "../agent/factories"
import { createClaudeCodeProvider } from "../agent/claude-code-provider"
import { createCodexProvider, discoverModels as discoverCodexProviderModels } from "../agent/codex-provider"
import { createOpenCodeProvider, discoverModels as discoverOpenCodeModels } from "../agent/opencode-provider"
import { buildPiPromptCommand, buildPiSystemPromptCommand, createPiProvider, discoverModels as discoverPiProviderModels } from "../agent/pi-provider"

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
  test("returns known Claude models", () => {
    const models = createClaudeCodeProvider().listModels()
    expect(models.length).toBeGreaterThan(0)
    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ])
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
