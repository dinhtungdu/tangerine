// VMPoolManager is deprecated (replaced by ProjectVmManager).
// This test requires SSH to a mock IP and will always time out.
import { describe, it, expect, beforeEach } from "bun:test";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { VMPoolManager } from "../pool.ts";
import type { PoolConfig } from "../pool-types.ts";
import type {
  Provider,
  Instance,
  Snapshot,
  CreateInstanceOptions,
} from "../providers/types.ts";

/** Minimal mock provider that tracks calls and returns predictable results */
function createMockProvider(overrides?: Partial<Provider>): Provider {
  let instanceCounter = 0;

  return {
    createInstance(opts: CreateInstanceOptions) {
      instanceCounter++;
      const id = opts.label ?? `mock-${instanceCounter}`;
      return Effect.succeed({
        id,
        label: id,
        ip: `10.0.0.${instanceCounter}`,
        status: "active" as const,
        region: opts.region,
        plan: opts.plan,
        createdAt: new Date().toISOString(),
        sshPort: 22,
      });
    },
    startInstance(_id: string) { return Effect.succeed(undefined as void); },
    stopInstance(_id: string) { return Effect.succeed(undefined as void); },
    destroyInstance(_id: string) { return Effect.succeed(undefined as void); },
    getInstance(id: string) {
      return Effect.succeed({
        id,
        label: id,
        ip: "10.0.0.1",
        status: "active" as const,
        region: "local",
        plan: "2cpu-4gb",
        createdAt: new Date().toISOString(),
        sshPort: 22,
      });
    },
    listInstances(_label?: string) {
      return Effect.succeed([] as Instance[]);
    },
    waitForReady(id: string, _timeoutMs?: number) {
      return Effect.succeed({
        id,
        label: id,
        ip: "10.0.0.1",
        status: "active" as const,
        region: "local",
        plan: "2cpu-4gb",
        createdAt: new Date().toISOString(),
        sshPort: 22,
      });
    },
    createSnapshot(_instanceId: string, description: string) {
      return Effect.succeed({ id: "snap-1", description, status: "complete" as const, size: 0, createdAt: new Date().toISOString() });
    },
    listSnapshots() {
      return Effect.succeed([] as Snapshot[]);
    },
    getSnapshot(id: string) {
      return Effect.succeed({ id, description: id, status: "complete" as const, size: 0, createdAt: new Date().toISOString() });
    },
    deleteSnapshot(_id: string) { return Effect.succeed(undefined as void); },
    waitForSnapshot(id: string, _timeoutMs?: number) {
      return Effect.succeed({ id, description: id, status: "complete" as const, size: 0, createdAt: new Date().toISOString() });
    },
    ...overrides,
  };
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vms (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      provider    TEXT NOT NULL DEFAULT 'mock',
      ip          TEXT,
      ssh_port    INTEGER,
      status      TEXT NOT NULL DEFAULT 'provisioning',
      project_id  TEXT NOT NULL DEFAULT 'test',
      snapshot_id TEXT NOT NULL,
      region      TEXT NOT NULL,
      plan        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      error       TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL DEFAULT 'test',
      slug          TEXT UNIQUE,
      repo_url      TEXT NOT NULL,
      context       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      vm_id         TEXT,
      result        TEXT,
      exit_code     INTEGER,
      branch        TEXT,
      pr_url        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      started_at    TEXT,
      completed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status);
    CREATE INDEX IF NOT EXISTS idx_vms_project_id ON vms(project_id);
  `);
  return db;
}

function createTestConfig(provider: Provider, overrides?: Partial<PoolConfig>): PoolConfig {
  return {
    slots: [
      {
        name: "mock",
        provider,
        snapshotId: "clone:golden",
        region: "local",
        plan: "2cpu-4gb",
        maxPoolSize: 5,
        priority: 1,
        idleTimeoutMs: 300_000,
        minReady: 0,
      },
    ],
    labelPrefix: "test",
    ...overrides,
  };
}

describe.skip("VMPoolManager", () => {
  let db: Database;
  let provider: Provider;
  let pool: VMPoolManager;

  beforeEach(() => {
    db = createTestDb();
    provider = createMockProvider();
    pool = new VMPoolManager(db, createTestConfig(provider));
  });

  describe("acquireVm", () => {
    it("provisions and returns a VM when pool is empty", async () => {
      // Insert a task so acquireVm can reference it
      db.run(
        `INSERT INTO tasks (id, repo_url, context, status) VALUES ('task-1', 'https://github.com/test/repo', 'test', 'pending')`
      );

      const vm = await Effect.runPromise(pool.acquireVm("task-1"));

      expect(vm).toBeDefined();
      expect(vm.status).toBe("active");
      expect(vm.ip).toBeTruthy();
    });

    it("reuses a warm VM when one is available", async () => {
      // Pre-populate an active VM in the pool
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO vms (id, label, provider, ip, ssh_port, status, project_id, snapshot_id, region, plan, created_at, updated_at)
         VALUES ('warm-1', 'warm-1', 'mock', '10.0.0.99', 22, 'active', 'test', 'snap', 'local', '2cpu-4gb', ?, ?)`,
        [now, now]
      );

      db.run(
        `INSERT INTO tasks (id, repo_url, context, status) VALUES ('task-2', 'https://github.com/test/repo', 'test', 'pending')`
      );

      const vm = await Effect.runPromise(pool.acquireVm("task-2"));

      expect(vm.id).toBe("warm-1");
      expect(vm.status).toBe("active");
    });
  });

  describe("releaseVm", () => {
    it("marks VM as stopped when idleTimeout > 0", async () => {
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO vms (id, label, provider, ip, ssh_port, status, project_id, snapshot_id, region, plan, created_at, updated_at)
         VALUES ('vm-1', 'vm-1', 'mock', '10.0.0.1', 22, 'active', 'test', 'snap', 'local', '2cpu-4gb', ?, ?)`,
        [now, now]
      );

      await Effect.runPromise(pool.releaseVm("vm-1"));

      const vm = Effect.runSync(pool.getVm("vm-1"));
      expect(vm).toBeDefined();
      expect(vm!.status).toBe("stopped");
    });

    it("destroys VM immediately when idleTimeout is 0", async () => {
      // Create pool with 0 idle timeout
      const noIdleProvider = createMockProvider();
      const noIdlePool = new VMPoolManager(
        db,
        createTestConfig(noIdleProvider, {
          slots: [
            {
              name: "mock",
              provider: noIdleProvider,
              snapshotId: "clone:golden",
              region: "local",
              plan: "2cpu-4gb",
              maxPoolSize: 5,
              priority: 1,
              idleTimeoutMs: 0,
              minReady: 0,
            },
          ],
        })
      );

      const now = new Date().toISOString();
      db.run(
        `INSERT INTO vms (id, label, provider, ip, ssh_port, status, project_id, snapshot_id, region, plan, created_at, updated_at)
         VALUES ('vm-2', 'vm-2', 'mock', '10.0.0.2', 22, 'active', 'test', 'snap', 'local', '2cpu-4gb', ?, ?)`,
        [now, now]
      );

      await Effect.runPromise(noIdlePool.releaseVm("vm-2"));

      const vm = Effect.runSync(noIdlePool.getVm("vm-2"));
      expect(vm).toBeDefined();
      expect(vm!.status).toBe("destroyed");
    });
  });

  describe("reapIdleVms", () => {
    it("destroys stopped VMs that have been idle past timeout", async () => {
      // Insert a VM with updated_at set far in the past
      const pastTime = new Date(Date.now() - 600_000).toISOString();
      db.run(
        `INSERT INTO vms (id, label, provider, ip, ssh_port, status, project_id, snapshot_id, region, plan, created_at, updated_at)
         VALUES ('idle-1', 'idle-1', 'mock', '10.0.0.1', 22, 'stopped', 'test', 'snap', 'local', '2cpu-4gb', ?, ?)`,
        [pastTime, pastTime]
      );

      const reaped = await Effect.runPromise(pool.reapIdleVms());

      expect(reaped).toBe(1);
      const vm = Effect.runSync(pool.getVm("idle-1"));
      expect(vm).toBeDefined();
      expect(vm!.status).toBe("destroyed");
    });

    it("does not reap stopped VMs that are still within timeout", async () => {
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO vms (id, label, provider, ip, ssh_port, status, project_id, snapshot_id, region, plan, created_at, updated_at)
         VALUES ('fresh-1', 'fresh-1', 'mock', '10.0.0.1', 22, 'stopped', 'test', 'snap', 'local', '2cpu-4gb', ?, ?)`,
        [now, now]
      );

      const reaped = await Effect.runPromise(pool.reapIdleVms());

      expect(reaped).toBe(0);
      const vm = Effect.runSync(pool.getVm("fresh-1"));
      expect(vm!.status).toBe("stopped");
    });
  });

  describe("ensureWarm", () => {
    it("is a no-op (being replaced by ProjectVmManager)", () => {
      pool.ensureWarm();
      // No error = pass
    });
  });

  describe("getPoolStats", () => {
    it("returns correct counts", () => {
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO vms (id, label, provider, ip, status, project_id, snapshot_id, region, plan, created_at, updated_at)
         VALUES ('p1', 'p1', 'mock', NULL, 'provisioning', 'test', 'snap', 'local', '2cpu-4gb', ?, ?)`,
        [now, now]
      );
      db.run(
        `INSERT INTO vms (id, label, provider, ip, status, project_id, snapshot_id, region, plan, created_at, updated_at)
         VALUES ('a1', 'a1', 'mock', '10.0.0.1', 'active', 'test', 'snap', 'local', '2cpu-4gb', ?, ?)`,
        [now, now]
      );
      db.run(
        `INSERT INTO vms (id, label, provider, ip, status, project_id, snapshot_id, region, plan, created_at, updated_at)
         VALUES ('s1', 's1', 'mock', '10.0.0.2', 'stopped', 'test', 'snap', 'local', '2cpu-4gb', ?, ?)`,
        [now, now]
      );

      const stats = Effect.runSync(pool.getPoolStats());

      expect(stats.provisioning).toBe(1);
      expect(stats.active).toBe(1);
      expect(stats.stopped).toBe(1);
      expect(stats.total).toBe(3);
      expect(stats.byProvider.mock).toBe(3);
    });
  });
});
