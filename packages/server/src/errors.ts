import { Data } from "effect"

export class DbError extends Data.TaggedError("DbError")<{ message: string; cause?: unknown }> {}
export class ProviderError extends Data.TaggedError("ProviderError")<{ message: string; provider: string; operation: string; cause?: unknown }> {}
export class TaskNotFoundError extends Data.TaggedError("TaskNotFoundError")<{ taskId: string }> {}
export class PoolExhaustedError extends Data.TaggedError("PoolExhaustedError")<{ message: string }> {}
export class SessionStartError extends Data.TaggedError("SessionStartError")<{ message: string; taskId: string; phase: string; cause?: unknown }> {}
export class SessionCleanupError extends Data.TaggedError("SessionCleanupError")<{ message: string; taskId: string; cause?: unknown }> {}
export class AgentError extends Data.TaggedError("AgentError")<{ message: string; taskId: string; cause?: unknown }> {}
export class AgentConnectionError extends Data.TaggedError("AgentConnectionError")<{ message: string; taskId: string; url: string; cause?: unknown }> {}
export class PromptError extends Data.TaggedError("PromptError")<{ message: string; taskId: string; cause?: unknown }> {}
export class GitHubPollError extends Data.TaggedError("GitHubPollError")<{ message: string; statusCode?: number; cause?: unknown }> {}
export class HealthCheckError extends Data.TaggedError("HealthCheckError")<{ message: string; taskId: string; reason: "agent_dead" | "agent_stalled" }> {}
export class ProjectNotFoundError extends Data.TaggedError("ProjectNotFoundError")<{ name: string }> {}
export class ProjectExistsError extends Data.TaggedError("ProjectExistsError")<{ name: string }> {}
export class ConfigValidationError extends Data.TaggedError("ConfigValidationError")<{ message: string }> {}
export class TaskNotTerminalError extends Data.TaggedError("TaskNotTerminalError")<{ taskId: string; status: string }> {}
export class PrCapabilityError extends Data.TaggedError("PrCapabilityError")<{ taskId: string }> {
  get message() { return `Task ${this.taskId} does not have the "pr" capability` }
}
