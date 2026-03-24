/**
 * Project VM setup: single-layer approach.
 * Each project VM is created from tangerine.yaml template, then provisioned
 * via base-setup.sh (common tools) + optional project build.sh.
 */

import { resolve, join } from "path";
import { existsSync, mkdirSync, appendFileSync } from "fs";
import { Effect } from "effect";
import { sshExec, sshExecStreaming } from "../vm/ssh.ts";
import { TANGERINE_HOME, VM_USER } from "../config.ts";
import type { Logger } from "../logger.ts";

export const TEMPLATE_PATH = resolve(import.meta.dir, "tangerine.yaml");
const BASE_SETUP_PATH = resolve(import.meta.dir, "base-setup.sh");

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
 * Run base setup + project-specific setup (build.sh) inside a VM on first provisioning.
 * Checks for a marker file to skip if already done.
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

  const logFile = buildLogPath(imageName);
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(logFile, `\n=== Project setup: ${imageName} ===\n`);

  // 1. Upload and run base-setup.sh (common tools)
  appendLog(logFile, "Running base setup (common tools)...");
  log.info("Running base setup", { imageName });

  // Upload base-setup.sh
  const uploadBase = Bun.spawn(
    ["scp", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
     "-o", "LogLevel=ERROR", "-P", String(sshPort),
     BASE_SETUP_PATH, `${VM_USER}@${ip}:/tmp/base-setup.sh`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const uploadBaseExit = await uploadBase.exited;
  if (uploadBaseExit !== 0) {
    const stderr = await new Response(uploadBase.stderr).text();
    appendLog(logFile, `ERROR: Failed to upload base-setup.sh: ${stderr}`);
    throw new Error(`Failed to upload base-setup.sh: ${stderr}`);
  }

  // Run base-setup.sh with streaming output
  appendLog(logFile, "--- base-setup.sh output ---");
  const baseExitCode = await Effect.runPromise(sshExecStreaming(
    ip, sshPort,
    "sudo bash /tmp/base-setup.sh",
    (chunk) => {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.length > 0) appendFileSync(logFile, line + "\n");
      }
    },
  ));
  appendLog(logFile, `--- base-setup.sh finished (exit ${baseExitCode}) ---`);

  if (baseExitCode !== 0) {
    appendLog(logFile, `ERROR: Base setup failed with exit code ${baseExitCode}`);
    throw new Error(`Base setup failed with exit code ${baseExitCode}`);
  }

  // User-level setup (workspace ownership, git config, opencode config)
  await Effect.runPromise(sshExec(ip, sshPort, [
    "sudo chown $(whoami):$(whoami) /workspace",
    "git config --global safe.directory '*'",
    "mkdir -p ~/.config/opencode",
    "test -f ~/.config/opencode/opencode.json || echo '{}' > ~/.config/opencode/opencode.json",
  ].join(" && ")));

  // 2. Run project-specific build.sh (if exists)
  const buildScriptPath = join(imageDir(imageName), "build.sh");

  if (existsSync(buildScriptPath)) {
    appendLog(logFile, `Running project build script: ${buildScriptPath}`);
    log.info("Running project build script", { imageName, path: buildScriptPath });

    // Upload entire image directory to VM via tar over SSH
    const imgDir = imageDir(imageName);
    const tarProc = Bun.spawn(
      ["tar", "czf", "-", "-C", imgDir, "."],
      { stdout: "pipe" },
    );
    const uploadProc = Bun.spawn(
      ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
       "-o", "LogLevel=ERROR", "-p", String(sshPort),
       `${VM_USER}@${ip}`, "mkdir -p /tmp/image-build && tar xzf - -C /tmp/image-build"],
      { stdin: tarProc.stdout, stdout: "pipe", stderr: "pipe" },
    );
    await tarProc.exited;
    const uploadExit = await uploadProc.exited;
    if (uploadExit !== 0) {
      const stderr = await new Response(uploadProc.stderr).text();
      appendLog(logFile, `ERROR: Failed to upload image directory: ${stderr}`);
      throw new Error(`Failed to upload image directory: ${stderr}`);
    }

    // Execute with streaming output
    appendLog(logFile, "--- build.sh output ---");
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
    appendLog(logFile, `--- build.sh finished (exit ${exitCode}) ---`);

    if (exitCode !== 0) {
      appendLog(logFile, `ERROR: Build script failed with exit code ${exitCode}`);
      throw new Error(`Build script failed with exit code ${exitCode}`);
    }
  } else {
    appendLog(logFile, `No project build script at ${buildScriptPath}, skipping`);
    log.info("No project build script found, skipping", { imageName });
  }

  // Mark as done
  await Effect.runPromise(sshExec(ip, sshPort, `rm -f /tmp/base-setup.sh /tmp/build.sh && touch ${markerFile}`));
  appendLog(logFile, "Setup complete");
  log.info("Project setup complete", { imageName });
}
