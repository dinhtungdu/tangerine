// Token estimation and conversation prefix truncation for branched tasks.
// Uses a simple chars/4 heuristic — close enough for truncation decisions
// without requiring a tokenizer dependency.

import type { ConversationMessage } from "./prompts"

/** Rough token estimate: 1 token ≈ 4 characters for English prose. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Return the context window size for a model based on its ID.
 * Conservative defaults when the model is unknown.
 */
export function guessContextWindow(model?: string | null): number {
  if (!model) return 200_000
  const m = model.toLowerCase()
  if (m.includes("opus-4-7") || m.includes("opus-4-6")) return 1_000_000
  if (m.includes("opus")) return 200_000
  if (m.includes("gpt-5") || m.includes("o3") || m.includes("o4")) return 200_000
  if (m.includes("gpt-4")) return 128_000
  return 200_000
}

/**
 * Trim messages to fit within a token budget, keeping the most recent turns.
 * Always keeps at least the last message even if it alone exceeds the budget.
 */
export function truncateMessagesToTokenBudget(
  messages: ConversationMessage[],
  tokenBudget: number,
): ConversationMessage[] {
  if (messages.length === 0) return messages

  let total = 0
  const kept: ConversationMessage[] = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messages[i]!.content)
    if (total + cost > tokenBudget && kept.length > 0) break
    kept.unshift(messages[i]!)
    total += cost
  }

  return kept
}
