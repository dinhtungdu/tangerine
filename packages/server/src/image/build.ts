#!/usr/bin/env bun
/**
 * Golden image build script.
 * Creates a Lima VM from tangerine.yaml, runs ~/tangerine/images/<name>/build.sh,
 * stops the VM, and keeps it as the golden source for APFS CoW cloning.
 *
 * No `limactl snapshot` — VZ doesn't support it. Instead, `limactl clone`
 * uses APFS clonefile(2) for instant, space-efficient copies.
 */

import { resolve, join } from "path";
import { existsSync } from "fs";
import { Effect } from "effect";
import { LimaProvider } from "../vm/providers/lima.ts";
import { sshExec, waitForSsh } from "../vm/ssh.ts";
import { getDb } from "../db/index.ts";
import { createImage } from "../db/queries.ts";
import { TANGERINE_HOME } from "../config.ts";

const TEMPLATE_PATH = resolve(import.meta.dir, "tangerine.yaml");

/** Name convention for golden VMs kept as clone sources */
export function goldenVmName(imageName: string): string {
  return `tangerine-golden-${imageName}`;
}

/** Directory for a given image's assets (build.sh, etc.) */
export function imageDir(imageName: string): string {
  return join(TANGERINE_HOME, "images", imageName);
}

export async function buildImage(imageName: string): Promise<void> {
  const buildScriptPath = join(imageDir(imageName), "build.sh");
  const goldenName = goldenVmName(imageName);
  const provider = new LimaProvider({ templatePath: TEMPLATE_PATH });
  const db = getDb();

  console.log(`Building golden image: ${imageName}`);
  console.log(`Template: ${TEMPLATE_PATH}`);
  console.log(`Golden VM: ${goldenName}`);

  // Check if a golden VM already exists — destroy it first
  try {
    const existing = await Effect.runPromise(provider.getInstance(goldenName));
    if (existing) {
      console.log(`\n==> Destroying existing golden VM: ${goldenName}`);
      await Effect.runPromise(provider.destroyInstance(goldenName));
    }
  } catch {
    // Doesn't exist, that's fine
  }

  // Step 1: Create Lima VM from template
  console.log("\n==> Creating VM from template...");
  const instance = await Effect.runPromise(provider.createInstance({
    region: "local",
    plan: "4cpu-8gb",
    label: goldenName,
  }));
  console.log(`VM created: ${instance.id} (ip: ${instance.ip}, port: ${instance.sshPort})`);

  // Step 2: Wait for SSH
  console.log("\n==> Waiting for SSH...");
  await Effect.runPromise(waitForSsh(
    instance.ip,
    instance.sshPort ?? 22,
  ));
  console.log("SSH ready");

  // Step 3: Run project's build script if it exists
  if (existsSync(buildScriptPath)) {
    console.log(`\n==> Running build script: ${buildScriptPath}`);
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
      throw new Error(`Failed to upload build script: ${stderr}`);
    }

    // Execute the build script
    const buildResult = await Effect.runPromise(sshExec(
      instance.ip,
      instance.sshPort ?? 22,
      "bash -l /tmp/build.sh",
    ));
    if (buildResult) console.log(buildResult);

    // Clean up build script
    await Effect.runPromise(sshExec(
      instance.ip,
      instance.sshPort ?? 22,
      "rm -f /tmp/build.sh",
    ));
  } else {
    console.log(`\n==> No build script at ${buildScriptPath}, using base image only`);
  }

  // Step 4: Stop the VM — keep it as the golden source for cloning
  // No snapshot needed: `limactl clone` uses APFS clonefile (CoW, instant, space-efficient)
  console.log("\n==> Stopping golden VM...");
  await Effect.runPromise(provider.stopInstance(goldenName));
  console.log("Golden VM stopped (kept as clone source)");

  // Step 5: Record in DB
  const imageId = `img-${imageName}-${Date.now()}`;
  Effect.runSync(createImage(db, {
    id: imageId,
    name: imageName,
    provider: "lima",
    snapshot_id: `clone:${goldenName}`,
  }));
  console.log(`Image recorded in DB: ${imageId}`);

  console.log(`\nGolden image "${imageName}" built successfully.`);
  console.log(`Clone source: ${goldenName}`);
  console.log(`Pool VMs will be cloned from this VM using APFS copy-on-write.`);
}

// CLI entry point
const imageName = process.argv[2];
if (!imageName) {
  console.error("Usage: bun run packages/server/src/image/build.ts <image-name>");
  process.exit(1);
}

buildImage(imageName).catch((err) => {
  console.error(`\nBuild failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
