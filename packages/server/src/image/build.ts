/**
 * Base image build + project VM setup.
 *
 * Single-layer approach:
 * 1. Base layer (tangerine-base): built from tangerine.yaml with cloud-init.
 *    Contains all common tools (Node.js, OpenCode, Claude Code, etc.).
 *    Only rebuilt when tangerine.yaml changes (~10 min).
 * 2. Project VMs clone directly from base. Project-specific setup (build.sh)
 *    runs on first provisioning and is cached on the persistent VM.
 *
 * `limactl clone` uses APFS clonefile(2) for instant, space-efficient copies.
 */

import { resolve, join } from "path";
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "fs";
import { Effect } from "effect";
import { LimaProvider } from "../vm/providers/lima.ts";
import { sshExec, sshExecStreaming, waitForSsh } from "../vm/ssh.ts";
import { TANGERINE_HOME, VM_USER } from "../config.ts";
import type { Logger } from "../logger.ts";

const TEMPLATE_PATH = resolve(import.meta.dir, "tangerine.yaml");
export const BASE_VM_NAME = "tangerine-base";

/** Log directory for build output */
const LOG_DIR = join(TANGERINE_HOME, "logs");

/** Path to the build log file for a given image */
export function buildLogPath(imageName: string): string {
  return join(LOG_DIR, `image-build-${imageName}.log`);
}

/** Directory for a given image's assets (build.sh, etc.) */
export function imageDir(imageName: string): string {
  return join(TANGERINE_HOME, "images", imageName);
}

/** Append a timestamped line to the build log file */
function appendLog(logFile: string, line: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  appendFileSync(logFile, `[${ts}] ${line}\n`);
}

/**
 * Ensure the base VM exists and is stopped.
 * The base VM is built from tangerine.yaml with full cloud-init provisioning.
 * It only needs to be rebuilt when the template changes.
 */
async function ensureBase(provider: LimaProvider, logFile: string, log: Logger): Promise<void> {
  // Check if base VM already exists
  try {
    const base = await Effect.runPromise(provider.getInstance(BASE_VM_NAME));
    if (base) {
      // Base exists — make sure it's stopped (ready for cloning)
      if (base.status === "active") {
        appendLog(logFile, "Stopping base VM for cloning...");
        await Effect.runPromise(provider.stopInstance(BASE_VM_NAME));
      }
      appendLog(logFile, "Base VM ready (reusing existing)");
      log.info("Base VM ready", { baseVm: BASE_VM_NAME });
      return;
    }
  } catch {
    // Doesn't exist — build it
  }

  appendLog(logFile, "Building base VM from template (one-time)...");
  log.info("Building base VM from template", { template: TEMPLATE_PATH });

  const instance = await Effect.runPromise(provider.createInstance({
    region: "local",
    plan: "4cpu-8gb",
    label: BASE_VM_NAME,
  }));
  appendLog(logFile, `Base VM created: ${instance.id} (ip: ${instance.ip}, port: ${instance.sshPort})`);
  log.info("Base VM created", { id: instance.id });

  // Wait for SSH — cloud-init provisioning happens during limactl start
  appendLog(logFile, "Waiting for base VM SSH...");
  await Effect.runPromise(waitForSsh(instance.ip, instance.sshPort ?? 22));
  appendLog(logFile, "Base VM SSH ready");

  // Verify key tools installed
  const verifyResult = await Effect.runPromise(sshExec(
    instance.ip, instance.sshPort ?? 22,
    [
      "echo 'node:' $(node --version)",
      "echo 'npm:' $(npm --version)",
      "echo 'gh:' $(gh --version 2>/dev/null | head -1 || echo 'not found')",
      "echo 'tmux:' $(tmux -V 2>/dev/null || echo 'not found')",
      "echo 'opencode:' $(which opencode 2>/dev/null || echo 'not found')",
      "echo 'claude:' $(which claude 2>/dev/null || echo 'not found')",
    ].join(" && "),
  ));
  appendLog(logFile, `Base VM tools:\n${verifyResult.trim()}`);

  // Stop for cloning
  await Effect.runPromise(provider.stopInstance(BASE_VM_NAME));
  appendLog(logFile, "Base VM stopped (ready for cloning)");
  log.info("Base VM built and stopped", { baseVm: BASE_VM_NAME });
}

/**
 * Build only the base VM from template. Called from CLI and dashboard.
 * This is the slow step (~10 min) that installs all common tools.
 * Always destroys and recreates the base VM to pick up template changes.
 */
export async function buildBase(log: Logger): Promise<void> {
  const provider = new LimaProvider({ templatePath: TEMPLATE_PATH });
  const logFile = buildLogPath("base");

  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(logFile, `=== Base image build ===\n`);
  appendLog(logFile, `Template: ${TEMPLATE_PATH}`);

  // Destroy existing base VM to force a fresh build
  try {
    const existing = await Effect.runPromise(provider.getInstance(BASE_VM_NAME));
    if (existing) {
      appendLog(logFile, "Destroying existing base VM for rebuild...");
      log.info("Destroying existing base VM for rebuild");
      if (existing.status === "active") {
        await Effect.runPromise(provider.stopInstance(BASE_VM_NAME));
      }
      await Effect.runPromise(provider.destroyInstance(BASE_VM_NAME));
      appendLog(logFile, "Existing base VM destroyed");
    }
  } catch {
    // Doesn't exist, fine
  }

  await ensureBase(provider, logFile, log);
}

/**
 * Run project-specific setup (build.sh) inside a VM on first provisioning.
 * Checks for a marker file to skip if already done.
 * Called by ProjectVmManager after cloning from base.
 */
export async function runProjectSetup(
  imageName: string,
  ip: string,
  sshPort: number,
  log: Logger,
): Promise<void> {
  const markerFile = "$HOME/.tangerine-setup-done";

  // Check if setup already ran
  try {
    const result = await Effect.runPromise(sshExec(ip, sshPort, `test -f ${markerFile} && echo "done" || echo "needed"`));
    if (result.trim() === "done") {
      log.info("Project setup already complete, skipping", { imageName });
      return;
    }
  } catch {
    // SSH might fail if VM is still booting — proceed with setup
  }

  const buildScriptPath = join(imageDir(imageName), "build.sh");
  const logFile = buildLogPath(imageName);

  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(logFile, `\n=== Project setup: ${imageName} ===\n`);

  if (!existsSync(buildScriptPath)) {
    appendLog(logFile, `No build script at ${buildScriptPath}, skipping project setup`);
    log.info("No build script found, skipping project setup", { imageName });
    // Still write marker so we don't check again
    await Effect.runPromise(sshExec(ip, sshPort, `touch ${markerFile}`));
    return;
  }

  const imgDir = imageDir(imageName);
  appendLog(logFile, `Running build script: ${buildScriptPath}`);
  log.info("Running project setup", { imageName, path: buildScriptPath });

  // Upload entire image directory to VM via tar over SSH
  const tarProc = Bun.spawn(
    ["tar", "czf", "-", "-C", imgDir, "."],
    { stdout: "pipe" },
  );
  const uploadProc = Bun.spawn(
    ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
     "-o", "LogLevel=ERROR", "-p", String(sshPort),
     `${VM_USER}@${ip}`, "mkdir -p /tmp/image-build && tar xzf - -C /tmp/image-build"],
    {
      stdin: tarProc.stdout,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  await tarProc.exited;
  const uploadExit = await uploadProc.exited;
  if (uploadExit !== 0) {
    const stderr = await new Response(uploadProc.stderr).text();
    appendLog(logFile, `ERROR: Failed to upload image directory: ${stderr}`);
    throw new Error(`Failed to upload image directory: ${stderr}`);
  }

  // Execute with streaming output
  appendLog(logFile, "--- build script output ---");
  const exitCode = await Effect.runPromise(sshExecStreaming(
    ip, sshPort,
    "bash -l /tmp/image-build/build.sh",
    (chunk) => {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.length > 0) appendFileSync(logFile, line + "\n");
      }
    },
  ));
  appendLog(logFile, `--- build script finished (exit ${exitCode}) ---`);

  if (exitCode !== 0) {
    appendLog(logFile, `ERROR: Build script failed with exit code ${exitCode}`);
    throw new Error(`Build script failed with exit code ${exitCode}`);
  }

  // Cleanup and mark as done
  await Effect.runPromise(sshExec(ip, sshPort, `rm -f /tmp/build.sh && touch ${markerFile}`));
  appendLog(logFile, "Project setup complete");
  log.info("Project setup complete", { imageName });
}
