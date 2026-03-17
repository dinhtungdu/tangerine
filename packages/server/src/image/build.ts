/**
 * Golden image build script.
 *
 * Two-layer approach for fast builds:
 * 1. Base layer (tangerine-base): built from tangerine.yaml with cloud-init.
 *    Contains all common tools (Node.js, Docker, OpenCode, etc.).
 *    Only rebuilt when tangerine.yaml changes (~10 min).
 * 2. Project layer (tangerine-golden-<name>): cloned from base, runs build.sh.
 *    Only project-specific setup (PHP, repo clone, deps). Fast (~2-5 min).
 *
 * `limactl clone` uses APFS clonefile(2) for instant, space-efficient copies.
 */

import { resolve, join } from "path";
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "fs";
import { Effect } from "effect";
import { LimaProvider } from "../vm/providers/lima.ts";
import { sshExec, sshExecStreaming, waitForSsh } from "../vm/ssh.ts";
import { getDb } from "../db/index.ts";
import { createImage } from "../db/queries.ts";
import { TANGERINE_HOME } from "../config.ts";
import type { Logger } from "../logger.ts";

const TEMPLATE_PATH = resolve(import.meta.dir, "tangerine.yaml");
const BASE_VM_NAME = "tangerine-base";

/** Log directory for build output */
const LOG_DIR = join(TANGERINE_HOME, "logs");

/** Path to the build log file for a given image */
export function buildLogPath(imageName: string): string {
  return join(LOG_DIR, `image-build-${imageName}.log`);
}

/** Name convention for golden VMs kept as clone sources */
export function goldenVmName(imageName: string): string {
  return `tangerine-golden-${imageName}`;
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
    "node --version && docker --version && opencode --version 2>/dev/null || echo 'opencode not found'",
  ));
  appendLog(logFile, `Base VM tools: ${verifyResult.trim()}`);

  // Stop for cloning
  await Effect.runPromise(provider.stopInstance(BASE_VM_NAME));
  appendLog(logFile, "Base VM stopped (ready for cloning)");
  log.info("Base VM built and stopped", { baseVm: BASE_VM_NAME });
}

/**
 * Build only the base VM from template. Called from CLI.
 * This is the slow step (~10 min) that installs all common tools.
 */
export async function buildBase(log: Logger): Promise<void> {
  const provider = new LimaProvider({ templatePath: TEMPLATE_PATH });
  const logFile = buildLogPath("base");

  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(logFile, `=== Base image build ===\n`);
  appendLog(logFile, `Template: ${TEMPLATE_PATH}`);

  await ensureBase(provider, logFile, log);
}

/**
 * Build a project golden image. If `requireBase` is true (default for dashboard),
 * fails if the base VM doesn't exist instead of building it on the fly.
 */
export async function buildImage(imageName: string, log: Logger, opts?: { requireBase?: boolean }): Promise<void> {
  const buildScriptPath = join(imageDir(imageName), "build.sh");
  const goldenName = goldenVmName(imageName);
  const provider = new LimaProvider({ templatePath: TEMPLATE_PATH });
  const db = getDb();
  const logFile = buildLogPath(imageName);

  // Ensure log directory exists and start fresh
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(logFile, `=== Golden image build: ${imageName} ===\n`);
  appendLog(logFile, `Template: ${TEMPLATE_PATH}`);
  appendLog(logFile, `Golden VM: ${goldenName}`);

  log.info("Building golden image", { imageName, template: TEMPLATE_PATH, goldenVm: goldenName });

  // Step 1: Check base VM exists
  if (opts?.requireBase) {
    try {
      await Effect.runPromise(provider.getInstance(BASE_VM_NAME));
    } catch {
      throw new Error(`Base VM "${BASE_VM_NAME}" not found. Run "tangerine image build-base" first.`);
    }
    // Ensure it's stopped for cloning
    const base = await Effect.runPromise(provider.getInstance(BASE_VM_NAME));
    if (base.status === "active") {
      await Effect.runPromise(provider.stopInstance(BASE_VM_NAME));
    }
  } else {
    await ensureBase(provider, logFile, log);
  }

  // Step 2: Destroy existing golden VM if any
  try {
    const existing = await Effect.runPromise(provider.getInstance(goldenName));
    if (existing) {
      appendLog(logFile, "Destroying existing golden VM...");
      log.info("Destroying existing golden VM", { goldenVm: goldenName });
      await Effect.runPromise(provider.destroyInstance(goldenName));
      appendLog(logFile, "Existing VM destroyed");
    }
  } catch {
    // Doesn't exist, that's fine
  }

  // Step 3: Clone from base (instant via APFS CoW)
  appendLog(logFile, `Cloning base VM → ${goldenName}...`);
  log.info("Cloning base VM", { from: BASE_VM_NAME, to: goldenName });
  const instance = await Effect.runPromise(provider.createInstance({
    region: "local",
    plan: "4cpu-8gb",
    label: goldenName,
    snapshotId: `clone:${BASE_VM_NAME}`,
  }));
  appendLog(logFile, `Golden VM cloned: ${instance.id} (ip: ${instance.ip}, port: ${instance.sshPort})`);
  log.info("Golden VM cloned", { id: instance.id, ip: instance.ip, sshPort: instance.sshPort });

  // Step 4: Wait for SSH
  appendLog(logFile, "Waiting for SSH...");
  log.info("Waiting for SSH");
  await Effect.runPromise(waitForSsh(instance.ip, instance.sshPort ?? 22));
  appendLog(logFile, "SSH ready");
  log.info("SSH ready");

  // Step 5: Run project's build script if it exists
  if (existsSync(buildScriptPath)) {
    appendLog(logFile, `Running build script: ${buildScriptPath}`);
    log.info("Running build script", { path: buildScriptPath });
    const scriptContent = await Bun.file(buildScriptPath).text();
    const scriptBase64 = Buffer.from(scriptContent).toString("base64");

    // Upload build script to VM via stdin
    const uploadProc = Bun.spawn(
      ["ssh", "-o", "StrictHostKeyChecking=no", "-p", String(instance.sshPort ?? 22),
       `agent@${instance.ip}`, "base64 -d > /tmp/build.sh && chmod +x /tmp/build.sh"],
      {
        stdin: Buffer.from(scriptBase64),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const uploadExit = await uploadProc.exited;
    if (uploadExit !== 0) {
      const stderr = await new Response(uploadProc.stderr).text();
      appendLog(logFile, `ERROR: Failed to upload build script: ${stderr}`);
      throw new Error(`Failed to upload build script: ${stderr}`);
    }

    // Execute the build script with streaming output to log file
    appendLog(logFile, "--- build script output ---");
    const exitCode = await Effect.runPromise(sshExecStreaming(
      instance.ip,
      instance.sshPort ?? 22,
      "bash -l /tmp/build.sh",
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

    // Clean up build script
    await Effect.runPromise(sshExec(
      instance.ip,
      instance.sshPort ?? 22,
      "rm -f /tmp/build.sh",
    ));
  } else {
    appendLog(logFile, `No build script at ${buildScriptPath}, using base image only`);
    log.info("No build script found, using base image only", { path: buildScriptPath });
  }

  // Step 6: Stop the VM — keep it as the golden source for cloning
  appendLog(logFile, "Stopping golden VM...");
  log.info("Stopping golden VM");
  await Effect.runPromise(provider.stopInstance(goldenName));
  appendLog(logFile, "Golden VM stopped (kept as clone source)");
  log.info("Golden VM stopped (kept as clone source)");

  // Step 7: Record in DB
  const imageId = `img-${imageName}-${Date.now()}`;
  Effect.runSync(createImage(db, {
    id: imageId,
    name: imageName,
    provider: "lima",
    snapshot_id: `clone:${goldenName}`,
  }));
  appendLog(logFile, `Image recorded: ${imageId}`);
  appendLog(logFile, `\n=== Build complete ===`);
  log.info("Golden image built successfully", { imageId, cloneSource: goldenName });
}
