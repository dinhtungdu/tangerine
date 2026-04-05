import { formatModelName } from "./format"

function normalizeSearchValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function getSubsequenceScore(candidate: string, query: string): number {
  let queryIndex = 0
  let start = -1
  let end = -1

  for (let candidateIndex = 0; candidateIndex < candidate.length && queryIndex < query.length; candidateIndex += 1) {
    if (candidate[candidateIndex] !== query[queryIndex]) continue
    if (start === -1) start = candidateIndex
    end = candidateIndex
    queryIndex += 1
  }

  if (queryIndex !== query.length || start === -1 || end === -1) return 0

  const compactness = end - start - query.length + 1
  return 100 - compactness
}

function getCandidateScore(candidate: string, query: string): number {
  if (!candidate || !query) return 0
  if (candidate === query) return 1000
  if (candidate.startsWith(query)) return 800 - (candidate.length - query.length)

  const index = candidate.indexOf(query)
  if (index !== -1) return 600 - index

  return getSubsequenceScore(candidate, query)
}

export function searchModels(models: string[], query: string): string[] {
  const normalizedQuery = normalizeSearchValue(query)
  if (!normalizedQuery) return models

  return models
    .map((model, index) => {
      const normalizedModel = normalizeSearchValue(model)
      const normalizedDisplayName = normalizeSearchValue(formatModelName(model))
      const score = Math.max(
        getCandidateScore(normalizedModel, normalizedQuery),
        getCandidateScore(normalizedDisplayName, normalizedQuery),
      )

      return { model, score, index }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.model)
}
