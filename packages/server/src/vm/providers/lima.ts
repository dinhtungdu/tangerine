import { readFileSync, writeFileSync } from "fs";
import { Effect } from "effect";
import type {
  Provider,
  Instance,
  Snapshot,
  CreateInstanceOptions,
} from "./types.ts";
import { ProviderError } from "../../errors";

interface LimaConfig {
  templatePath: string;
}

interface LimaInstance {
  name: string;
  status: string;
  dir: string;
  arch: string;
  cpus: number;
  memory: number;
  disk: number;
  sshConfigFile: string;
  sshAddress: string;
  config: {
    user?: { name?: string };
    ssh?: { localPort?: number };
  };
}

export class LimaProvider implements Provider {
  private templatePath: string;

  constructor(config: LimaConfig) {
    this.templatePath = config.templatePath;
  }

  private exec(
    args: string[],
    timeoutMs = 60_000
  ): Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, ProviderError> {
    return Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["limactl", ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        const exitCode = await proc.exited;
        clearTimeout(timer);

        if (timedOut) {
          throw new Error(`limactl ${args[0]} timed out after ${timeoutMs}ms`);
        }

        return { exitCode, stdout, stderr };
      },
      catch: (e) => new ProviderError({
        message: `limactl ${args[0]} failed: ${e}`,
        provider: "lima",
        operation: args[0] ?? "unknown",
        cause: e,
      }),
    });
  }

  private execOrThrow(args: string[], timeoutMs?: number): Effect.Effect<string, ProviderError> {
    return Effect.gen(this, function* () {
      const result = yield* this.exec(args, timeoutMs);
      if (result.exitCode !== 0) {
        return yield* Effect.fail(new ProviderError({
          message: `limactl ${args[0]} failed (exit ${result.exitCode}): ${result.stderr}`,
          provider: "lima",
          operation: args[0] ?? "unknown",
        }));
      }
      return result.stdout;
    });
  }

  /** Run limactl with inherited stdio (output goes straight to terminal) */
  private execInherit(args: string[], timeoutMs = 60_000): Effect.Effect<void, ProviderError> {
    return Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["limactl", ...args], {
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);

        const exitCode = await proc.exited;
        clearTimeout(timer);

        if (timedOut) {
          throw new Error(`limactl ${args[0]} timed out after ${timeoutMs}ms`);
        }
        if (exitCode !== 0) {
          throw new Error(`limactl ${args[0]} failed (exit ${exitCode})`);
        }
      },
      catch: (e) => new ProviderError({
        message: `limactl ${args[0]} failed: ${e}`,
        provider: "lima",
        operation: args[0] ?? "unknown",
        cause: e,
      }),
    });
  }

  /** Patch a cloned VM's lima.yaml to disable auto port-forwarding */
  private patchCloneConfig(name: string): Effect.Effect<void, ProviderError> {
    return Effect.try({
      try: () => {
        const configPath = `${process.env.HOME}/.lima/${name}/lima.yaml`;
        const content = readFileSync(configPath, "utf-8");
        if (!content.includes("portForwards")) {
          const patch = [
            "",
            "portForwards:",
            "  - guestIP: \"0.0.0.0\"",
            "    guestPortRange: [1, 65535]",
            "    ignore: true",
            "  - guestIP: \"127.0.0.1\"",
            "    guestPortRange: [1, 65535]",
            "    ignore: true",
            "",
          ].join("\n");
          writeFileSync(configPath, content + patch);
        }
      },
      catch: (e) => new ProviderError({ message: `Failed to patch clone config: ${e}`, provider: "lima", operation: "patchCloneConfig", cause: e }),
    });
  }

  private getLimaInstance(name: string): Effect.Effect<LimaInstance | null, ProviderError> {
    return Effect.gen(this, function* () {
      const result = yield* this.exec(["list", name, "--json"]);
      if (result.exitCode !== 0) return null;

      // limactl list --json outputs one JSON object per line (JSONL)
      for (const line of result.stdout.trim().split("\n")) {
        if (!line) continue;
        try {
          const inst = JSON.parse(line) as LimaInstance;
          if (inst.name === name) return inst;
        } catch {
          continue;
        }
      }
      return null;
    });
  }

  private parseSshPort(sshConfigFile: string): Effect.Effect<number, ProviderError> {
    return Effect.tryPromise({
      try: async () => {
        try {
          const content = await Bun.file(sshConfigFile).text();
          const match = content.match(/^\s*Port\s+(\d+)/m);
          if (match?.[1]) return parseInt(match[1], 10);
        } catch {
          // Config doesn't exist yet (VM still starting)
        }
        return 22;
      },
      catch: (e) => new ProviderError({
        message: `Failed to parse SSH port: ${e}`,
        provider: "lima",
        operation: "parseSshPort",
        cause: e,
      }),
    });
  }

  private mapInstance(raw: LimaInstance): Effect.Effect<Instance, ProviderError> {
    return Effect.gen(this, function* () {
      const sshPort = yield* this.parseSshPort(raw.sshConfigFile);
      return {
        id: raw.name,
        label: raw.name,
        ip: raw.sshAddress || "127.0.0.1",
        status: mapLimaStatus(raw.status),
        region: "local",
        plan: `${raw.cpus}cpu-${Math.round(raw.memory / (1024 * 1024 * 1024))}gb`,
        createdAt: new Date().toISOString(),
        sshPort,
      };
    });
  }

  createInstance(opts: CreateInstanceOptions): Effect.Effect<Instance, ProviderError> {
    return Effect.gen(this, function* () {
      const name = opts.label ?? `tangerine-${Date.now()}`;
      const template = opts.snapshotId || this.templatePath;
      const verbose = process.env.TANGERINE_VERBOSE === "1";

      if (template.startsWith("clone:")) {
        // Clone-based creation: deep-copy a golden image's disk+config
        const goldenName = template.slice("clone:".length);
        if (verbose) {
          yield* this.execInherit(["clone", "--tty=false", goldenName, name], 120_000);
        } else {
          yield* this.execOrThrow(["clone", "--tty=false", goldenName, name], 120_000);
        }
        // limactl clone doesn't copy portForwards — patch before start
        yield* this.patchCloneConfig(name);
        if (verbose) {
          yield* this.execInherit(["start", name, "--tty=false"], 240_000);
        } else {
          yield* this.execOrThrow(["start", name, "--tty=false"], 240_000);
        }
      } else {
        // Template-based creation: full cloud-init provisioning
        // First run can take 10+ min (image download + provisioning)
        if (verbose) {
          yield* this.execInherit(["start", "--name", name, template, "--tty=false"], 600_000);
        } else {
          yield* this.execOrThrow(["start", "--name", name, template, "--tty=false"], 600_000);
        }
      }

      const raw = yield* this.getLimaInstance(name);
      if (!raw) {
        return yield* Effect.fail(new ProviderError({
          message: `Lima instance ${name} created but not found in list`,
          provider: "lima",
          operation: "createInstance",
        }));
      }

      return yield* this.mapInstance(raw);
    });
  }

  startInstance(id: string): Effect.Effect<void, ProviderError> {
    return Effect.gen(this, function* () {
      yield* this.execOrThrow(["start", id, "--tty=false"], 120_000);
    });
  }

  stopInstance(id: string): Effect.Effect<void, ProviderError> {
    return Effect.gen(this, function* () {
      yield* this.execOrThrow(["stop", id, "--tty=false"], 60_000);
    });
  }

  destroyInstance(id: string): Effect.Effect<void, ProviderError> {
    return Effect.gen(this, function* () {
      const inst = yield* this.getLimaInstance(id);
      if (!inst) return;

      // Force-stop first (immediate kill, no graceful shutdown) — ignore errors if already stopped
      yield* this.exec(["stop", "--force", id, "--tty=false"], 30_000);
      yield* this.execOrThrow(["delete", "--force", id, "--tty=false"], 30_000);
    });
  }

  getInstance(id: string): Effect.Effect<Instance, ProviderError> {
    return Effect.gen(this, function* () {
      const raw = yield* this.getLimaInstance(id);
      if (!raw) {
        return yield* Effect.fail(new ProviderError({
          message: `Lima instance ${id} not found`,
          provider: "lima",
          operation: "getInstance",
        }));
      }
      return yield* this.mapInstance(raw);
    });
  }

  listInstances(label?: string): Effect.Effect<Instance[], ProviderError> {
    return Effect.gen(this, function* () {
      const result = yield* this.exec(["list", "--json"]);
      if (result.exitCode !== 0) return [];

      const instances: Instance[] = [];
      for (const line of result.stdout.trim().split("\n")) {
        if (!line) continue;
        try {
          const raw = JSON.parse(line) as LimaInstance;
          if (label && !raw.name.includes(label)) continue;
          if (!label && !raw.name.startsWith("tangerine-")) continue;
          instances.push(yield* this.mapInstance(raw));
        } catch {
          continue;
        }
      }
      return instances;
    });
  }

  waitForReady(id: string, timeoutMs = 300_000): Effect.Effect<Instance, ProviderError> {
    return Effect.tryPromise({
      try: async () => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const instance = await Effect.runPromise(this.getInstance(id));
          if (instance.status === "active") {
            return instance;
          }
          if (instance.status === "error") {
            throw new Error(`Lima instance ${id} entered error state`);
          }
          const elapsed = Math.round((Date.now() - start) / 1000);
          console.log(`Lima ${id}: ${instance.status} (${elapsed}s elapsed)`);
          await sleep(3_000);
        }
        throw new Error(`Lima instance ${id} did not become ready within ${timeoutMs / 1000}s`);
      },
      catch: (e) => new ProviderError({
        message: `waitForReady failed: ${e}`,
        provider: "lima",
        operation: "waitForReady",
        cause: e,
      }),
    });
  }

  // Snapshot support — Lima snapshots are per-instance (save/restore state)
  // Compound ID format: "instance:tag"

  createSnapshot(instanceId: string, description: string): Effect.Effect<Snapshot, ProviderError> {
    return Effect.gen(this, function* () {
      const tag = description.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();

      // Instance must be stopped to snapshot
      yield* this.exec(["stop", instanceId, "--tty=false"]);
      yield* this.execOrThrow(["snapshot", "create", instanceId, "--tag", tag]);

      return {
        id: `${instanceId}:${tag}`,
        description,
        status: "complete" as const,
        size: 0,
        createdAt: new Date().toISOString(),
      };
    });
  }

  listSnapshots(): Effect.Effect<Snapshot[], ProviderError> {
    return Effect.gen(this, function* () {
      const instances = yield* this.listInstances();
      const snapshots: Snapshot[] = [];

      for (const inst of instances) {
        const result = yield* this.exec(["snapshot", "list", inst.id]);
        if (result.exitCode !== 0) continue;

        for (const line of result.stdout.trim().split("\n")) {
          const tag = line.trim();
          if (!tag || tag.startsWith("NAME") || tag.startsWith("---")) continue;
          snapshots.push({
            id: `${inst.id}:${tag}`,
            description: tag,
            status: "complete",
            size: 0,
            createdAt: new Date().toISOString(),
          });
        }
      }

      return snapshots;
    });
  }

  getSnapshot(id: string): Effect.Effect<Snapshot, ProviderError> {
    return Effect.gen(function* () {
      const [instanceId, tag] = id.split(":");
      if (!instanceId || !tag) {
        return yield* Effect.fail(new ProviderError({
          message: `Invalid snapshot ID format: ${id} (expected "instance:tag")`,
          provider: "lima",
          operation: "getSnapshot",
        }));
      }

      return {
        id,
        description: tag,
        status: "complete" as const,
        size: 0,
        createdAt: new Date().toISOString(),
      };
    });
  }

  deleteSnapshot(id: string): Effect.Effect<void, ProviderError> {
    return Effect.gen(this, function* () {
      const [instanceId, tag] = id.split(":");
      if (!instanceId || !tag) {
        return yield* Effect.fail(new ProviderError({
          message: `Invalid snapshot ID format: ${id} (expected "instance:tag")`,
          provider: "lima",
          operation: "deleteSnapshot",
        }));
      }
      yield* this.execOrThrow(["snapshot", "delete", instanceId, "--tag", tag]);
    });
  }

  waitForSnapshot(_id: string, _timeoutMs?: number): Effect.Effect<Snapshot, ProviderError> {
    // Lima snapshots are instant (local disk)
    return this.getSnapshot(_id);
  }
}

function mapLimaStatus(status: string): Instance["status"] {
  switch (status) {
    case "Running":
      return "active";
    case "Stopped":
      return "stopped";
    case "Starting":
    case "Creating":
      return "pending";
    default:
      return "error";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
