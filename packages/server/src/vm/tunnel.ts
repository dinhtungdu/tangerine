import type { Subprocess } from "bun";
import { createServer } from "node:net";
import { Effect } from "effect";
import { TunnelError } from "../errors";
import { VM_USER } from "../config";

export interface SessionTunnel {
  vmIp: string;
  sshPort: number;
  agentPort: number;
  process: Subprocess;
}

export function createTunnel(opts: {
  vmIp: string;
  sshPort: number;
  user?: string;
  remoteOpencodePort?: number;
}): Effect.Effect<SessionTunnel, TunnelError> {
  return Effect.tryPromise({
    try: async () => {
      const user = opts.user ?? VM_USER;
      const remoteOpencodePort = opts.remoteOpencodePort ?? 4096;

      const agentPort = await Effect.runPromise(allocatePort());

      const args = [
        "ssh",
        "-N",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "BatchMode=yes",
        "-o", "LogLevel=ERROR",
        "-o", "ExitOnForwardFailure=yes",
        "-p", String(opts.sshPort),
        "-L", `${agentPort}:127.0.0.1:${remoteOpencodePort}`,
        `${user}@${opts.vmIp}`,
      ];

      const process = Bun.spawn(args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });

      // Give the tunnel a moment to establish or fail
      const settled = await Promise.race([
        new Promise<"exited">((resolve) => {
          process.exited.then(() => resolve("exited"));
        }),
        new Promise<"ok">((resolve) => {
          setTimeout(() => resolve("ok"), 2_000);
        }),
      ]);

      if (settled === "exited") {
        const stderr = await new Response(process.stderr).text();
        throw new Error(`SSH tunnel exited immediately: ${stderr}`);
      }

      return {
        vmIp: opts.vmIp,
        sshPort: opts.sshPort,
        agentPort,
        process,
      };
    },
    catch: (e) => new TunnelError({ message: `Tunnel creation failed: ${e}`, vmIp: opts.vmIp, cause: e }),
  });
}

export interface PreviewTunnel {
  localPort: number;
  vmIp: string;
  sshPort: number;
  process: Subprocess;
}

/** On-demand SSH -L tunnel for preview port forwarding. */
export function createPreviewTunnel(opts: {
  vmIp: string;
  sshPort: number;
  remotePort: number;
  user?: string;
}): Effect.Effect<PreviewTunnel, TunnelError> {
  return Effect.tryPromise({
    try: async () => {
      const user = opts.user ?? VM_USER;
      const localPort = await Effect.runPromise(allocatePort());

      const args = [
        "ssh",
        "-N",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "BatchMode=yes",
        "-o", "LogLevel=ERROR",
        "-o", "ExitOnForwardFailure=yes",
        "-p", String(opts.sshPort),
        "-L", `${localPort}:127.0.0.1:${opts.remotePort}`,
        `${user}@${opts.vmIp}`,
      ];

      const process = Bun.spawn(args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });

      const settled = await Promise.race([
        new Promise<"exited">((resolve) => {
          process.exited.then(() => resolve("exited"));
        }),
        new Promise<"ok">((resolve) => {
          setTimeout(() => resolve("ok"), 2_000);
        }),
      ]);

      if (settled === "exited") {
        const stderr = await new Response(process.stderr).text();
        throw new Error(`Preview tunnel exited immediately: ${stderr}`);
      }

      return { localPort, vmIp: opts.vmIp, sshPort: opts.sshPort, process };
    },
    catch: (e) => new TunnelError({ message: `Preview tunnel creation failed: ${e}`, vmIp: opts.vmIp, cause: e }),
  });
}

export interface ProxyTunnel {
  vmIp: string;
  sshPort: number;
  remotePort: number;
  process: Subprocess;
}

/** Persistent reverse tunnel: forwards a host port into the VM via SSH -R.
 *  Used to give the VM access to a local SOCKS proxy for GHE. */
export function createProxyTunnel(opts: {
  vmIp: string;
  sshPort: number;
  localPort: number;
  user?: string;
}): Effect.Effect<ProxyTunnel, TunnelError> {
  return Effect.tryPromise({
    try: async () => {
      const user = opts.user ?? VM_USER;

      const args = [
        "ssh",
        "-N",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "BatchMode=yes",
        "-o", "LogLevel=ERROR",
        "-o", "ExitOnForwardFailure=yes",
        "-p", String(opts.sshPort),
        "-R", `${opts.localPort}:127.0.0.1:${opts.localPort}`,
        `${user}@${opts.vmIp}`,
      ];

      const process = Bun.spawn(args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });

      const settled = await Promise.race([
        new Promise<"exited">((resolve) => {
          process.exited.then(() => resolve("exited"));
        }),
        new Promise<"ok">((resolve) => {
          setTimeout(() => resolve("ok"), 2_000);
        }),
      ]);

      if (settled === "exited") {
        const stderr = await new Response(process.stderr).text();
        throw new Error(`Proxy tunnel exited immediately: ${stderr}`);
      }

      return {
        vmIp: opts.vmIp,
        sshPort: opts.sshPort,
        remotePort: opts.localPort,
        process,
      };
    },
    catch: (e) => new TunnelError({ message: `Proxy tunnel creation failed: ${e}`, vmIp: opts.vmIp, cause: e }),
  });
}

export function destroyProxyTunnel(tunnel: ProxyTunnel): Effect.Effect<void, never> {
  return Effect.sync(() => {
    try {
      tunnel.process.kill();
    } catch {
      // Process may already be dead
    }
  });
}

export function destroyTunnel(tunnel: SessionTunnel): Effect.Effect<void, never> {
  return Effect.sync(() => {
    try {
      tunnel.process.kill();
    } catch {
      // Process may already be dead
    }
  });
}

/** Find a free local port by binding to port 0 and reading the assigned port */
export function allocatePort(): Effect.Effect<number, TunnelError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            server.close();
            reject(new Error("Failed to allocate port: unexpected address type"));
            return;
          }
          const port = addr.port;
          server.close(() => resolve(port));
        });
        server.on("error", reject);
      }),
    catch: (e) => new TunnelError({ message: "Port allocation failed", vmIp: "localhost", cause: e }),
  });
}
