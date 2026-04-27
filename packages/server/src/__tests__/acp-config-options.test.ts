import { describe, expect, test } from "bun:test"
import { taskConfigUpdatesFromOptions } from "../agent/config-options"

describe("taskConfigUpdatesFromOptions", () => {
  test("derives task model and reasoning effort from ACP option categories", () => {
    expect(taskConfigUpdatesFromOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5",
        options: [{ value: "gpt-5", name: "GPT-5" }],
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [{ value: "high", name: "High" }],
      },
    ])).toEqual({ model: "gpt-5", reasoning_effort: "high" })
  })

  test("ignores unsupported categories", () => {
    expect(taskConfigUpdatesFromOptions([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "code",
        options: [{ value: "code", name: "Code" }],
      },
    ])).toEqual({})
  })
})
