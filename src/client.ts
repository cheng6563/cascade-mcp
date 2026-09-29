import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CascadeLogger } from "./logger.js";
import { compileRoute, shellQuote } from "./route.js";
import type {
  BridgeFrame,
  BridgeRequest,
  BridgeRequestInput,
  RouteSpec,
  SelectedCopyCompression,
} from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onMeta?: (value: unknown) => void;
  onData?: (data: Buffer, stream: "stdout" | "stderr" | "content") => unknown;
  cleanup: () => void;
}

function resolveHelperBinary(architecture: "amd64" | "arm64"): string {
  const binaryName = "pi-cascade-linux-" + architecture;
  if (process.env.CASCADE_HELPER_DIR) {
    const custom = join(process.env.CASCADE_HELPER_DIR, binaryName);
    if (existsSync(custom)) return custom;
  }
  try {
    const p1 = fileURLToPath(new URL("../bin/" + binaryName, import.meta.url));
    if (existsSync(p1)) return p1;
  } catch {}
  try {
    const p2 = fileURLToPath(new URL("./bin/" + binaryName, import.meta.url));
    if (existsSync(p2)) return p2;
  } catch {}
  const p3 = join(process.cwd(), "bin", binaryName);
  if (existsSync(p3)) return p3;
  return fileURLToPath(new URL("../bin/" + binaryName, import.meta.url));
}
let cachedAskPassPath: string | undefined;

function ensureAskPassScript(): string {
  if (cachedAskPassPath && existsSync(cachedAskPassPath)) {
    return cachedAskPassPath;
  }
  const isWin = process.platform === "win32";
  const baseDir = existsSync("./temp") ? "./temp" : (process.env.TEMP || tmpdir());
  const cascadeTempDir = join(baseDir, "pi-cascade-askpass");
  if (!existsSync(cascadeTempDir)) {
    mkdirSync(cascadeTempDir, { recursive: true });
  }

  const jsPath = join(cascadeTempDir, "askpass.cjs");
  const jsContent = `process.stdout.write(process.env.CASCADE_SSH_PASSWORD || "");\n`;
  writeFileSync(jsPath, jsContent, { encoding: "utf8" });

  if (isWin) {
    const cmdPath = join(cascadeTempDir, "askpass.cmd");
    const cmdContent = `@node "${jsPath}"\r\n`;
    writeFileSync(cmdPath, cmdContent, { encoding: "utf8" });
    cachedAskPassPath = cmdPath;
  } else {
    const shPath = join(cascadeTempDir, "askpass.sh");
    const shContent = `#!/bin/sh\nnode "${jsPath}"\n`;
    writeFileSync(shPath, shContent, { encoding: "utf8", mode: 0o755 });
    cachedAskPassPath = shPath;
  }
  return cachedAskPassPath;
}

function buildChildEnv(password?: string): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LC_ALL: "C.UTF-8",
  };
  if (password) {
    const askpassPath = ensureAskPassScript();
    env.SSH_ASKPASS = askpassPath;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.CASCADE_SSH_PASSWORD = password;
    env.DISPLAY = "dummy:0";
  }
  return env;
}

export class CascadeClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private starting?: Promise<void>;
  private closePromise?: Promise<void>;
  private startupAbort = new AbortController();
  private closing = false;
  private stderrTail = "";
  private outputBackpressure = 0;

  constructor(
    readonly profileName: string,
    readonly profile: RouteSpec,
    private readonly logger = new CascadeLogger(),
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    if (this.closing) throw new Error(`Cascade client ${this.profileName} is closing or closed`);
    if (signal?.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    const startupSignal = signal ? AbortSignal.any([signal, this.startupAbort.signal]) : this.startupAbort.signal;
    this.starting = this.startInternal(startupSignal).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async runRouteCommand(
    command: string,
    input?: Buffer,
    timeoutMs = 15_000,
    signal?: AbortSignal,
    routeOptions: { compressSsh?: boolean } = {},
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }> {
    if (signal?.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");
    const launch = compileRoute(this.profile, command, routeOptions);
    const child = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildChildEnv(launch.password),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => {
      // Catch write/pipe errors (e.g. EOF or EPIPE on early process exit) to prevent uncaughtException
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    if (input && input.length > 0) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
    let interrupted: Error | undefined;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const stop = (error: Error) => {
        interrupted = error;
        child.kill();
      };
      const abort = () => stop(new Error(signal?.reason ? String(signal.reason) : "aborted"));
      const timer = setTimeout(() => stop(new Error(`Cascade route command timed out after ${timeoutMs}ms`)), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (code, childSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve({ code, signal: childSignal });
      });
    });
    if (interrupted) throw interrupted;
    return { ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  }

  private async probeArchitecture(signal: AbortSignal): Promise<"amd64" | "arm64"> {
    const result = await this.runRouteCommand("printf 'os='; uname -s; printf 'arch='; uname -m", undefined, 15_000, signal);
    const output = result.stdout.toString("utf8");
    if (result.code !== 0 || !output.includes("os=Linux")) {
      const detail = result.stderr.toString("utf8").trim();
      if (detail.includes("Permission denied") || detail.includes("Authentication failed")) {
        throw new Error(`Cascade target SSH authentication failed for ${this.profileName}: ${detail}. If password authentication is required, specify the password in the target URL (e.g. ssh://user:pass@host) or via the password parameter.`);
      }
      throw new Error(`Cascade target probe failed (code=${result.code}, signal=${result.signal}): ${detail || output.trim()}`);
    }
    if (/arch=(x86_64|amd64)/.test(output)) return "amd64";
    if (/arch=(aarch64|arm64)/.test(output)) return "arm64";
    throw new Error(`Unsupported Cascade target architecture: ${output.trim()}`);
  }

  private async startInternal(signal: AbortSignal): Promise<void> {
    this.stderrTail = "";
    const architecture = await this.probeArchitecture(signal);
    const helperPath = resolveHelperBinary(architecture);
    const helper = await readFile(helperPath);
    const remoteHelper = `/tmp/pi-cascade-${process.pid}-${randomBytes(8).toString("hex")}`;
    const quotedHelper = shellQuote(remoteHelper);
    const upload = await this.runRouteCommand(
      `umask 077; cat > ${quotedHelper} && chmod 700 ${quotedHelper}`,
      helper,
      30_000,
      signal,
      { compressSsh: true },
    );
    if (upload.code !== 0) {
      await this.runRouteCommand(`rm -f ${quotedHelper}`, undefined, 10_000).catch(() => undefined);
      throw new Error(`Cascade helper upload failed (code=${upload.code}, signal=${upload.signal}): ${upload.stderr.toString("utf8").trim()}`);
    }
    await this.logger.write("helper_upload_done", {
      profile: this.profileName,
      architecture,
      bytes: helper.length,
      sshCompression: this.profile.route.some((layer) => layer.type === "ssh"),
    });
    const terminalCommand = `exec 3<${quotedHelper} && rm -f ${quotedHelper} && exec /proc/self/fd/3`;
    const launch = compileRoute(this.profile, terminalCommand);
    await this.logger.write("transport_start", { profile: this.profileName, route: launch.display });

    if (signal.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");
    const child = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildChildEnv(launch.password),
    });
    this.child = child;
    child.stdin.on("error", (error) => {
      if (!this.closing) this.failAll(error);
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        action();
      };
      const abort = () => finish(() => {
        child.kill();
        reject(new Error(signal.reason ? String(signal.reason) : "aborted"));
      });
      const timeout = setTimeout(() => finish(() => reject(new Error(`Cascade bridge startup timed out for ${this.profileName}`))), 20_000);
      signal.addEventListener("abort", abort, { once: true });
      let stdoutBuffer = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
        for (let newline = stdoutBuffer.indexOf(0x0a); newline >= 0; newline = stdoutBuffer.indexOf(0x0a)) {
          const raw = stdoutBuffer.subarray(0, newline);
          stdoutBuffer = stdoutBuffer.subarray(newline + 1);
          const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, -1).toString("utf8") : raw.toString("utf8");
          let frame: BridgeFrame;
          try {
            frame = JSON.parse(line) as BridgeFrame;
          } catch {
            void this.logger.write("protocol_error", { profile: this.profileName, line: line.slice(0, 500) });
            continue;
          }
          if (frame.id === "bridge" && frame.type === "ready") {
            finish(resolve);
            continue;
          }
          this.handleFrame(frame);
        }
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code, childSignal) => {
        const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : "";
        const error = new Error(`Cascade transport closed (code=${code}, signal=${childSignal})${suffix}`);
        finish(() => reject(error));
        this.failAll(error);
        if (this.child === child) this.child = undefined;
        void this.logger.write("transport_close", { profile: this.profileName, code, signal: childSignal, expected: this.closing });
      });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8192);
      void this.logger.write("transport_stderr", { profile: this.profileName, message: chunk.toString("utf8").slice(0, 2000) });
    });

    try {
      await ready;
      await this.logger.write("transport_ready", { profile: this.profileName, pid: child.pid });
    } catch (error) {
      child.kill();
      await this.runRouteCommand(`rm -f ${quotedHelper}`, undefined, 10_000).catch(() => undefined);
      throw error;
    }
  }

  private handleFrame(frame: BridgeFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (frame.type === "meta") {
      pending.onMeta?.(frame.result);
      return;
    }
    if (frame.type === "data" && frame.data && frame.stream) {
      const wait = pending.onData?.(Buffer.from(frame.data, "base64"), frame.stream);
      if (wait && typeof (wait as Promise<void>).then === "function") {
        const child = this.child;
        if (child) {
          this.outputBackpressure++;
          if (this.outputBackpressure === 1) child.stdout.pause();
          void Promise.resolve(wait)
            .catch((error) => pending.reject(error instanceof Error ? error : new Error(String(error))))
            .finally(() => {
              this.outputBackpressure--;
              if (this.outputBackpressure === 0 && this.child === child && !child.stdout.destroyed) child.stdout.resume();
            });
        }
      }
      return;
    }
    if (frame.type === "result") {
      this.pending.delete(frame.id);
      pending.cleanup();
      pending.resolve(frame.result);
      return;
    }
    if (frame.type === "error") {
      this.pending.delete(frame.id);
      pending.cleanup();
      pending.reject(new Error(frame.message || "Remote bridge operation failed"));
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async beginRequest<T>(
    request: BridgeRequestInput,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onMeta?: (value: unknown) => void;
      onData?: (data: Buffer, stream: "stdout" | "stderr" | "content") => unknown;
    } = {},
  ): Promise<{ id: string; promise: Promise<T> }> {
    await this.start(options.signal);
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("Cascade transport is not available");
    const id = `${process.pid}-${++this.sequence}` as string;
    const startedAt = Date.now();

    const promise = new Promise<T>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      let settled = false;
      let cancelling = false;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        cleanup();
        void this.logger.write("request_failed", { profile: this.profileName, id, op: request.op, durationMs: Date.now() - startedAt, error: error.message });
        reject(error);
      };
      const cancel = (failure: Error) => {
        if (settled || cancelling) return;
        cancelling = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        const cancelId = `${id}-cancel`;
        const fallback = setTimeout(() => {
          this.pending.delete(cancelId);
          void this.close().finally(() => fail(new Error(`${failure.message}; cancellation acknowledgement timed out, transport closed`)));
        }, 3000);
        this.pending.set(cancelId, {
          resolve: (value) => {
            const complete = (value as { complete?: boolean } | undefined)?.complete !== false;
            if (complete) {
              fail(failure);
              return;
            }
            void this.close().finally(() => fail(new Error(`${failure.message}; remote cancellation was not acknowledged, transport closed`)));
          },
          reject: () => fail(failure),
          cleanup: () => clearTimeout(fallback),
        });
        this.send({ id: cancelId, op: "cancel", target: id });
      };
      const abort = () => cancel(new Error(options.signal?.reason ? String(options.signal.reason) : "aborted"));
      if (options.signal?.aborted) {
        fail(new Error(options.signal.reason ? String(options.signal.reason) : "aborted"));
        return;
      }
      this.pending.set(id, {
        resolve: (value) => {
          if (settled || cancelling) return;
          settled = true;
          void this.logger.write("request_done", { profile: this.profileName, id, op: request.op, durationMs: Date.now() - startedAt });
          resolve(value as T);
        },
        reject: (error) => {
          if (!cancelling) fail(error);
        },
        onMeta: options.onMeta,
        onData: options.onData,
        cleanup,
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeoutMs = options.timeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => cancel(new Error(`timeout:${timeoutMs / 1000}`)), timeoutMs);
      }
      this.send({ ...request, id } as BridgeRequest);
    });
    return { id, promise };
  }

  async request<T>(
    request: BridgeRequestInput,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onMeta?: (value: unknown) => void;
      onData?: (data: Buffer, stream: "stdout" | "stderr" | "content") => unknown;
    } = {},
  ): Promise<T> {
    const pending = await this.beginRequest<T>(request, options);
    return pending.promise;
  }

  async upload<T>(
    request: { op: "copy_upload"; path: string; compression: SelectedCopyCompression; mode: number },
    chunks: AsyncIterable<Buffer>,
    options: { signal?: AbortSignal; onWireChunk?: (bytes: number) => void } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const pending = await this.beginRequest<T>(request, {
      signal,
      onMeta: (value) => {
        const meta = value as { ready?: boolean } | undefined;
        if (meta?.ready) readyResolve();
      },
    });
    const remote = pending.promise.catch((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      readyReject(normalized);
      controller.abort(normalized);
      throw normalized;
    });
    try {
      await Promise.race([
        ready,
        remote.then(() => { throw new Error("Copy upload finished before the helper accepted input"); }),
      ]);
      for await (const value of chunks) {
        for (let offset = 0; offset < value.length; offset += 64 * 1024) {
          const chunk = value.subarray(offset, Math.min(offset + 64 * 1024, value.length));
          await this.writeRequest({ id: pending.id, op: "copy_chunk", data: chunk.toString("base64") }, signal);
          options.onWireChunk?.(chunk.length);
        }
      }
      await this.writeRequest({ id: pending.id, op: "copy_end" }, signal);
      return await remote;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      controller.abort(normalized);
      await remote.catch(() => undefined);
      throw normalized;
    }
  }

  private async writeRequest(request: BridgeRequest, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) throw new Error("Cascade transport is not available");
    const payload = `${JSON.stringify(request)}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(payload, (error) => error ? reject(error) : resolve());
    });
  }

  private send(request: BridgeRequest): void {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) return;
    try {
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error && !this.closing) this.failAll(error);
      });
    } catch (error) {
      if (!this.closing) this.failAll(error as Error);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.startupAbort.abort("Cascade client closed during startup");
    this.closePromise = (async () => {
      try {
        await this.starting;
      } catch {
        // Startup failures already carry their own diagnostics.
      }
      const child = this.child;
      if (this.child === child) this.child = undefined;
      if (!child) return;
      try {
        if (!child.stdin.destroyed && child.stdin.writable) {
          child.stdin.end();
        }
      } catch {
        // Ignore stdin close errors during shutdown
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const graceful = setTimeout(() => child.kill(), 3000);
      let hardTimer: NodeJS.Timeout | undefined;
      const hardDeadline = new Promise<void>((resolve) => { hardTimer = setTimeout(resolve, 6000); });
      await Promise.race([closed, hardDeadline]);
      clearTimeout(graceful);
      if (hardTimer) clearTimeout(hardTimer);
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32" && child.pid) {
          await new Promise<void>((resolve) => {
            const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
            const deadline = setTimeout(() => { killer.kill(); resolve(); }, 3000);
            killer.once("error", () => { clearTimeout(deadline); resolve(); });
            killer.once("close", () => { clearTimeout(deadline); resolve(); });
          });
        } else {
          child.kill("SIGKILL");
        }
        let finalTimer: NodeJS.Timeout | undefined;
        const finalDeadline = new Promise<void>((resolve) => { finalTimer = setTimeout(resolve, 3000); });
        await Promise.race([closed, finalDeadline]);
        if (finalTimer) clearTimeout(finalTimer);
      }
    })();
    return this.closePromise;
  }
}
