#!/usr/bin/env node

// src/cli.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/manager.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync, writeFileSync as writeFileSync2 } from "fs";
import { homedir } from "os";
import path from "path";

// src/client.ts
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join as join2 } from "path";
import { fileURLToPath } from "url";

// src/logger.ts
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
var CascadeLogger = class {
  path;
  constructor(baseDir = process.env.TEMP || process.env.TMP || join(process.cwd(), "temp")) {
    this.path = join(baseDir, "cascade-mcp", "cascade.jsonl");
  }
  async write(event, fields = {}) {
    try {
      await mkdir(join(this.path, ".."), { recursive: true });
      await appendFile(this.path, `${JSON.stringify({ timestamp: (/* @__PURE__ */ new Date()).toISOString(), event, ...fields })}
`, "utf8");
    } catch {
    }
  }
};

// src/route.ts
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function sshTargetString(layer) {
  if (layer.user && !layer.host.includes("@")) {
    return `${layer.user}@${layer.host}`;
  }
  return layer.host;
}
function jumpHopString(layer) {
  let hop = "";
  if (layer.user && !layer.host.includes("@")) hop += `${layer.user}@`;
  hop += layer.host;
  if (layer.port) hop += `:${layer.port}`;
  return hop;
}
function sshOptions(layer, connectTimeoutSeconds, includeJumpHosts = true, compress = false) {
  const args = [
    "-T",
    "-o",
    `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3"
  ];
  if (compress) args.push("-C");
  if (!layer.password) {
    args.push("-o", "BatchMode=yes");
  }
  if (layer.port) args.push("-p", String(layer.port));
  if (layer.identityFile) args.push("-i", layer.identityFile);
  if (includeJumpHosts && layer.jumpHosts?.length) args.push("-J", layer.jumpHosts.join(","));
  for (const option of layer.options ?? []) args.push("-o", option);
  return args;
}
function dockerArgs(layer, command) {
  const args = ["exec", "-i"];
  if (layer.user) args.push("-u", layer.user);
  args.push(layer.container, "/bin/sh", "-lc", command);
  return args;
}
function nestedCommand(layer, command, connectTimeoutSeconds, compressSsh) {
  if (layer.type === "docker") return ["docker", ...dockerArgs(layer, command).map(shellQuote)].join(" ");
  const options = sshOptions(layer, connectTimeoutSeconds, true, compressSsh).map(shellQuote);
  return ["ssh", ...options, shellQuote(sshTargetString(layer)), shellQuote(command)].join(" ");
}
function canFlattenAsJump(layer) {
  return layer.identityFile === void 0 && layer.password === void 0 && (layer.options?.length ?? 0) === 0 && (layer.jumpHosts?.length ?? 0) === 0;
}
function compileRoute(profile, terminalCommand, options = {}) {
  const timeout = profile.connectTimeoutSeconds ?? 10;
  const compressSsh = options.compressSsh ?? false;
  let leadingSshCount = 0;
  while (leadingSshCount < profile.route.length && profile.route[leadingSshCount]?.type === "ssh") leadingSshCount++;
  if (leadingSshCount > 0) {
    const leading = profile.route.slice(0, leadingSshCount);
    const target = leading[leading.length - 1];
    const flattenStart = leading.slice(0, -1).every(canFlattenAsJump);
    if (flattenStart) {
      let command2 = terminalCommand;
      for (let index = profile.route.length - 1; index >= leadingSshCount; index--) {
        command2 = nestedCommand(profile.route[index], command2, timeout, compressSsh);
      }
      const jumps = [...leading.slice(0, -1).map(jumpHopString), ...target.jumpHosts ?? []];
      const args2 = sshOptions(target, timeout, false, compressSsh);
      if (jumps.length > 0) args2.push("-J", jumps.join(","));
      const targetStr2 = sshTargetString(target);
      args2.push(targetStr2, command2);
      return {
        command: "ssh",
        args: args2,
        display: [...jumps, targetStr2].join(" \u2192 ssh:"),
        password: target.password
      };
    }
  }
  const first = profile.route[0];
  let command = terminalCommand;
  for (let index = profile.route.length - 1; index >= 1; index--) {
    command = nestedCommand(profile.route[index], command, timeout, compressSsh);
  }
  if (first.type === "docker") {
    return { command: "docker", args: dockerArgs(first, command), display: `docker:${first.container}` };
  }
  const args = sshOptions(first, timeout, true, compressSsh);
  const targetStr = sshTargetString(first);
  args.push(targetStr, command);
  return {
    command: "ssh",
    args,
    display: `ssh:${targetStr}`,
    password: first.password
  };
}
function describeRoute(route) {
  return route.map((layer) => {
    if (layer.type === "ssh") {
      let s = "ssh:";
      if (layer.user && !layer.host.includes("@")) s += `${layer.user}@`;
      s += layer.host;
      if (layer.port) s += `:${layer.port}`;
      return s;
    }
    return `docker:${layer.container}${layer.user ? `?user=${layer.user}` : ""}`;
  }).join(" \u2192 ");
}

// src/client.ts
function resolveHelperBinary(architecture) {
  const binaryName = "pi-cascade-linux-" + architecture;
  if (process.env.CASCADE_HELPER_DIR) {
    const custom = join2(process.env.CASCADE_HELPER_DIR, binaryName);
    if (existsSync(custom)) return custom;
  }
  try {
    const p1 = fileURLToPath(new URL("../bin/" + binaryName, import.meta.url));
    if (existsSync(p1)) return p1;
  } catch {
  }
  try {
    const p2 = fileURLToPath(new URL("./bin/" + binaryName, import.meta.url));
    if (existsSync(p2)) return p2;
  } catch {
  }
  const p3 = join2(process.cwd(), "bin", binaryName);
  if (existsSync(p3)) return p3;
  return fileURLToPath(new URL("../bin/" + binaryName, import.meta.url));
}
var cachedAskPassPath;
function ensureAskPassScript() {
  if (cachedAskPassPath && existsSync(cachedAskPassPath)) {
    return cachedAskPassPath;
  }
  const isWin = process.platform === "win32";
  const baseDir = existsSync("./temp") ? "./temp" : process.env.TEMP || tmpdir();
  const cascadeTempDir = join2(baseDir, "pi-cascade-askpass");
  if (!existsSync(cascadeTempDir)) {
    mkdirSync(cascadeTempDir, { recursive: true });
  }
  const jsPath = join2(cascadeTempDir, "askpass.cjs");
  const jsContent = `process.stdout.write(process.env.CASCADE_SSH_PASSWORD || "");
`;
  writeFileSync(jsPath, jsContent, { encoding: "utf8" });
  if (isWin) {
    const cmdPath = join2(cascadeTempDir, "askpass.cmd");
    const cmdContent = `@node "${jsPath}"\r
`;
    writeFileSync(cmdPath, cmdContent, { encoding: "utf8" });
    cachedAskPassPath = cmdPath;
  } else {
    const shPath = join2(cascadeTempDir, "askpass.sh");
    const shContent = `#!/bin/sh
node "${jsPath}"
`;
    writeFileSync(shPath, shContent, { encoding: "utf8", mode: 493 });
    cachedAskPassPath = shPath;
  }
  return cachedAskPassPath;
}
function buildChildEnv(password) {
  const env = {
    ...process.env,
    LC_ALL: "C.UTF-8"
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
var CascadeClient = class {
  constructor(profileName, profile, logger = new CascadeLogger()) {
    this.profileName = profileName;
    this.profile = profile;
    this.logger = logger;
  }
  profileName;
  profile;
  logger;
  child;
  pending = /* @__PURE__ */ new Map();
  sequence = 0;
  starting;
  closePromise;
  startupAbort = new AbortController();
  closing = false;
  stderrTail = "";
  outputBackpressure = 0;
  async start(signal) {
    if (this.closing) throw new Error(`Cascade client ${this.profileName} is closing or closed`);
    if (signal?.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    const startupSignal = signal ? AbortSignal.any([signal, this.startupAbort.signal]) : this.startupAbort.signal;
    this.starting = this.startInternal(startupSignal).finally(() => {
      this.starting = void 0;
    });
    return this.starting;
  }
  async runRouteCommand(command, input, timeoutMs = 15e3, signal, routeOptions = {}) {
    if (signal?.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");
    const launch = compileRoute(this.profile, command, routeOptions);
    const child = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildChildEnv(launch.password)
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", () => {
    });
    child.stdout.on("error", () => {
    });
    child.stderr.on("error", () => {
    });
    if (input && input.length > 0) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
    let interrupted;
    const result = await new Promise((resolve, reject) => {
      const stop = (error) => {
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
  async probeArchitecture(signal) {
    const result = await this.runRouteCommand("printf 'os='; uname -s; printf 'arch='; uname -m", void 0, 15e3, signal);
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
  async startInternal(signal) {
    this.stderrTail = "";
    const architecture = await this.probeArchitecture(signal);
    const helperPath = resolveHelperBinary(architecture);
    const helper = await readFile(helperPath);
    const remoteHelper = `/tmp/pi-cascade-${process.pid}-${randomBytes(8).toString("hex")}`;
    const quotedHelper = shellQuote(remoteHelper);
    const upload = await this.runRouteCommand(
      `umask 077; cat > ${quotedHelper} && chmod 700 ${quotedHelper}`,
      helper,
      3e4,
      signal,
      { compressSsh: true }
    );
    if (upload.code !== 0) {
      await this.runRouteCommand(`rm -f ${quotedHelper}`, void 0, 1e4).catch(() => void 0);
      throw new Error(`Cascade helper upload failed (code=${upload.code}, signal=${upload.signal}): ${upload.stderr.toString("utf8").trim()}`);
    }
    await this.logger.write("helper_upload_done", {
      profile: this.profileName,
      architecture,
      bytes: helper.length,
      sshCompression: this.profile.route.some((layer) => layer.type === "ssh")
    });
    const terminalCommand = `exec 3<${quotedHelper} && rm -f ${quotedHelper} && exec /proc/self/fd/3`;
    const launch = compileRoute(this.profile, terminalCommand);
    await this.logger.write("transport_start", { profile: this.profileName, route: launch.display });
    if (signal.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");
    const child = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildChildEnv(launch.password)
    });
    this.child = child;
    child.stdin.on("error", (error) => {
      if (!this.closing) this.failAll(error);
    });
    child.stdout.on("error", () => {
    });
    child.stderr.on("error", () => {
    });
    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action) => {
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
      const timeout = setTimeout(() => finish(() => reject(new Error(`Cascade bridge startup timed out for ${this.profileName}`))), 2e4);
      signal.addEventListener("abort", abort, { once: true });
      let stdoutBuffer = Buffer.alloc(0);
      child.stdout.on("data", (chunk) => {
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
        for (let newline = stdoutBuffer.indexOf(10); newline >= 0; newline = stdoutBuffer.indexOf(10)) {
          const raw = stdoutBuffer.subarray(0, newline);
          stdoutBuffer = stdoutBuffer.subarray(newline + 1);
          const line = raw.length > 0 && raw[raw.length - 1] === 13 ? raw.subarray(0, -1).toString("utf8") : raw.toString("utf8");
          let frame;
          try {
            frame = JSON.parse(line);
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
        if (this.child === child) this.child = void 0;
        void this.logger.write("transport_close", { profile: this.profileName, code, signal: childSignal, expected: this.closing });
      });
    });
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8192);
      void this.logger.write("transport_stderr", { profile: this.profileName, message: chunk.toString("utf8").slice(0, 2e3) });
    });
    try {
      await ready;
      await this.logger.write("transport_ready", { profile: this.profileName, pid: child.pid });
    } catch (error) {
      child.kill();
      await this.runRouteCommand(`rm -f ${quotedHelper}`, void 0, 1e4).catch(() => void 0);
      throw error;
    }
  }
  handleFrame(frame) {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (frame.type === "meta") {
      pending.onMeta?.(frame.result);
      return;
    }
    if (frame.type === "data" && frame.data && frame.stream) {
      const wait = pending.onData?.(Buffer.from(frame.data, "base64"), frame.stream);
      if (wait && typeof wait.then === "function") {
        const child = this.child;
        if (child) {
          this.outputBackpressure++;
          if (this.outputBackpressure === 1) child.stdout.pause();
          void Promise.resolve(wait).catch((error) => pending.reject(error instanceof Error ? error : new Error(String(error)))).finally(() => {
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
  failAll(error) {
    for (const [, pending] of this.pending) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
  async beginRequest(request, options = {}) {
    await this.start(options.signal);
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("Cascade transport is not available");
    const id = `${process.pid}-${++this.sequence}`;
    const startedAt = Date.now();
    const promise = new Promise((resolve, reject) => {
      let timeout;
      let settled = false;
      let cancelling = false;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        cleanup();
        void this.logger.write("request_failed", { profile: this.profileName, id, op: request.op, durationMs: Date.now() - startedAt, error: error.message });
        reject(error);
      };
      const cancel = (failure) => {
        if (settled || cancelling) return;
        cancelling = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        const cancelId = `${id}-cancel`;
        const fallback = setTimeout(() => {
          this.pending.delete(cancelId);
          void this.close().finally(() => fail(new Error(`${failure.message}; cancellation acknowledgement timed out, transport closed`)));
        }, 3e3);
        this.pending.set(cancelId, {
          resolve: (value) => {
            const complete = value?.complete !== false;
            if (complete) {
              fail(failure);
              return;
            }
            void this.close().finally(() => fail(new Error(`${failure.message}; remote cancellation was not acknowledged, transport closed`)));
          },
          reject: () => fail(failure),
          cleanup: () => clearTimeout(fallback)
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
          resolve(value);
        },
        reject: (error) => {
          if (!cancelling) fail(error);
        },
        onMeta: options.onMeta,
        onData: options.onData,
        cleanup
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeoutMs = options.timeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => cancel(new Error(`timeout:${timeoutMs / 1e3}`)), timeoutMs);
      }
      this.send({ ...request, id });
    });
    return { id, promise };
  }
  async request(request, options = {}) {
    const pending = await this.beginRequest(request, options);
    return pending.promise;
  }
  async upload(request, chunks, options = {}) {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const pending = await this.beginRequest(request, {
      signal,
      onMeta: (value) => {
        const meta = value;
        if (meta?.ready) readyResolve();
      }
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
        remote.then(() => {
          throw new Error("Copy upload finished before the helper accepted input");
        })
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
      await remote.catch(() => void 0);
      throw normalized;
    }
  }
  async writeRequest(request, signal) {
    if (signal?.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) throw new Error("Cascade transport is not available");
    const payload = `${JSON.stringify(request)}
`;
    await new Promise((resolve, reject) => {
      child.stdin.write(payload, (error) => error ? reject(error) : resolve());
    });
  }
  send(request) {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) return;
    try {
      child.stdin.write(`${JSON.stringify(request)}
`, (error) => {
        if (error && !this.closing) this.failAll(error);
      });
    } catch (error) {
      if (!this.closing) this.failAll(error);
    }
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.startupAbort.abort("Cascade client closed during startup");
    this.closePromise = (async () => {
      try {
        await this.starting;
      } catch {
      }
      const child = this.child;
      if (this.child === child) this.child = void 0;
      if (!child) return;
      try {
        if (!child.stdin.destroyed && child.stdin.writable) {
          child.stdin.end();
        }
      } catch {
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise((resolve) => child.once("close", () => resolve()));
      const graceful = setTimeout(() => child.kill(), 3e3);
      let hardTimer;
      const hardDeadline = new Promise((resolve) => {
        hardTimer = setTimeout(resolve, 6e3);
      });
      await Promise.race([closed, hardDeadline]);
      clearTimeout(graceful);
      if (hardTimer) clearTimeout(hardTimer);
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32" && child.pid) {
          await new Promise((resolve) => {
            const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
            const deadline = setTimeout(() => {
              killer.kill();
              resolve();
            }, 3e3);
            killer.once("error", () => {
              clearTimeout(deadline);
              resolve();
            });
            killer.once("close", () => {
              clearTimeout(deadline);
              resolve();
            });
          });
        } else {
          child.kill("SIGKILL");
        }
        let finalTimer;
        const finalDeadline = new Promise((resolve) => {
          finalTimer = setTimeout(resolve, 3e3);
        });
        await Promise.race([closed, finalDeadline]);
        if (finalTimer) clearTimeout(finalTimer);
      }
    })();
    return this.closePromise;
  }
};

// src/target.ts
import { spawn as spawn2 } from "child_process";
function parseSshToken(rawToken, index) {
  let content = rawToken.trim();
  if (content.startsWith("ssh://")) {
    content = content.slice(6);
  } else if (content.startsWith("ssh:")) {
    content = content.slice(4);
    if (content.startsWith("//")) content = content.slice(2);
  }
  let queryString = "";
  const queryIndex = content.indexOf("?");
  if (queryIndex >= 0) {
    queryString = content.slice(queryIndex + 1);
    content = content.slice(0, queryIndex);
  }
  let user;
  let password;
  let host = "";
  let port;
  let identityFile;
  let jumpHosts;
  let options;
  if (queryString) {
    const params = new URLSearchParams(queryString);
    const p = params.get("port") ?? params.get("p");
    if (p) {
      const parsedPort = Number.parseInt(p, 10);
      if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
        port = parsedPort;
      }
    }
    const u = params.get("user") ?? params.get("u") ?? params.get("username");
    if (u) user = u;
    const pwd = params.get("password") ?? params.get("pass") ?? params.get("pwd");
    if (pwd) password = pwd;
    const idf = params.get("identityFile") ?? params.get("identity") ?? params.get("i") ?? params.get("key");
    if (idf) identityFile = idf;
    const jh = params.get("jumpHosts") ?? params.get("jump") ?? params.get("j");
    if (jh) jumpHosts = jh.split(",").map((s) => s.trim()).filter(Boolean);
    const opts = params.getAll("options").concat(params.getAll("option")).concat(params.getAll("o"));
    if (opts.length > 0) options = opts.filter(Boolean);
  }
  if (content.includes("@")) {
    const atIndex = content.lastIndexOf("@");
    const authPart = content.slice(0, atIndex);
    content = content.slice(atIndex + 1);
    if (authPart.includes(":")) {
      const colonIndex = authPart.indexOf(":");
      user = decodeURIComponent(authPart.slice(0, colonIndex)) || user;
      password = decodeURIComponent(authPart.slice(colonIndex + 1)) || password;
    } else if (authPart) {
      user = decodeURIComponent(authPart) || user;
    }
  }
  if (content.startsWith("[") && content.includes("]")) {
    const closeBracket = content.indexOf("]");
    host = content.slice(1, closeBracket);
    const rest = content.slice(closeBracket + 1);
    if (rest.startsWith(":")) {
      const parsedPort = Number.parseInt(rest.slice(1), 10);
      if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
        port = parsedPort;
      }
    }
  } else if (content.includes(":")) {
    const lastColon = content.lastIndexOf(":");
    const possiblePort = content.slice(lastColon + 1);
    const parsedPort = Number.parseInt(possiblePort, 10);
    if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
      host = content.slice(0, lastColon);
      port = parsedPort;
    } else {
      host = content;
    }
  } else {
    host = content;
  }
  host = host.trim();
  if (!host) throw new Error(`SSH host is missing at route layer ${index + 1}`);
  return {
    type: "ssh",
    host,
    ...user ? { user } : {},
    ...port ? { port } : {},
    ...password ? { password } : {},
    ...identityFile ? { identityFile } : {},
    ...jumpHosts && jumpHosts.length > 0 ? { jumpHosts } : {},
    ...options && options.length > 0 ? { options } : {}
  };
}
function parseDockerToken(rawToken, index) {
  let content = rawToken.trim();
  if (content.startsWith("docker:")) content = content.slice(7);
  let user;
  const queryIndex = content.indexOf("?");
  if (queryIndex >= 0) {
    const queryString = content.slice(queryIndex + 1);
    content = content.slice(0, queryIndex);
    const params = new URLSearchParams(queryString);
    const u = params.get("user") ?? params.get("u");
    if (u) user = u;
  }
  const container = content.trim();
  if (!container) throw new Error(`Docker container is missing at route layer ${index + 1}`);
  return {
    type: "docker",
    container,
    ...user ? { user } : {}
  };
}
function formatRouteLayer(layer, hidePassword = true) {
  if (layer.type === "docker") {
    return `docker:${layer.container}${layer.user ? `?user=${encodeURIComponent(layer.user)}` : ""}`;
  }
  let target = "ssh:";
  if (layer.user && layer.password && !hidePassword) {
    target += `${encodeURIComponent(layer.user)}:${encodeURIComponent(layer.password)}@`;
  } else if (layer.user) {
    target += `${encodeURIComponent(layer.user)}@`;
  }
  target += layer.host;
  if (layer.port) {
    target += `:${layer.port}`;
  }
  const params = new URLSearchParams();
  if (layer.identityFile) params.set("identityFile", layer.identityFile);
  if (layer.jumpHosts && layer.jumpHosts.length > 0) params.set("jumpHosts", layer.jumpHosts.join(","));
  for (const opt of layer.options ?? []) params.append("options", opt);
  if (layer.password && !hidePassword && !layer.user) params.set("password", layer.password);
  const q = params.toString();
  if (q) target += `?${q}`;
  return target;
}
function parseTargetSpec(input, options) {
  const value = input.trim();
  if (!value) throw new Error("Target is required");
  if (!value.includes("|") && value.includes(":") && !value.startsWith("ssh:") && !value.startsWith("ssh://") && !value.startsWith("docker:")) {
    throw new Error(`Unsupported target layer: ${value}. Use ssh:<host> or docker:<container>`);
  }
  const tokens = value.includes("|") || value.startsWith("ssh:") || value.startsWith("ssh://") || value.startsWith("docker:") ? value.split("|").map((token) => token.trim()).filter(Boolean) : [`docker:${value}`];
  if (tokens.length === 0) throw new Error("Target route is empty");
  const route = tokens.map((token, index) => {
    if (token.startsWith("ssh:") || token.startsWith("ssh://")) {
      return parseSshToken(token, index);
    }
    if (token.startsWith("docker:")) {
      return parseDockerToken(token, index);
    }
    if (!token.includes(":")) {
      return parseDockerToken(token, index);
    }
    throw new Error(`Unsupported target layer: ${token}. Use ssh:<host> or docker:<container>`);
  });
  if (options?.defaultPassword) {
    for (const layer of route) {
      if (layer.type === "ssh" && !layer.password) {
        layer.password = options.defaultPassword;
      }
    }
  }
  return {
    normalized: route.map((layer) => formatRouteLayer(layer, true)).join("|"),
    route
  };
}
function parseDockerPs(output, prefix = "") {
  const containers = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const id = String(value.ID ?? value.Id ?? "").trim();
    const name = String(value.Names ?? value.Name ?? "").trim();
    if (!id || !name) continue;
    containers.push({
      id,
      name,
      image: String(value.Image ?? ""),
      status: String(value.Status ?? value.State ?? ""),
      ports: String(value.Ports ?? "") || void 0,
      createdAt: String(value.CreatedAt ?? value.RunningFor ?? "") || void 0,
      connectionTarget: `${prefix}${prefix ? "|" : ""}docker:${id}`
    });
  }
  return containers;
}
function abortError(signal) {
  return new Error(signal.reason ? String(signal.reason) : "aborted");
}
async function runCaptured(command, args, signal, timeoutMs = 15e3) {
  if (signal?.aborted) throw abortError(signal);
  const child = spawn2(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stdout = [];
  const stderr = [];
  let interrupted;
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdout.on("error", () => {
  });
  child.stderr.on("error", () => {
  });
  const result = await new Promise((resolve, reject) => {
    const stop = (error) => {
      interrupted = error;
      child.kill();
    };
    const abort = () => stop(abortError(signal));
    const timer = setTimeout(() => stop(new Error(`docker ps timed out after ${timeoutMs}ms`)), timeoutMs);
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
  if (result.code !== 0) {
    throw new Error(`docker ps failed (code=${result.code}, signal=${result.signal}): ${Buffer.concat(stderr).toString("utf8").trim()}`);
  }
  return Buffer.concat(stdout).toString("utf8");
}
async function listDockerContainers(prefix, signal) {
  const format = "{{json .}}";
  if (!prefix) {
    const output2 = await runCaptured("docker", ["ps", "--no-trunc", "--format", format], signal);
    return parseDockerPs(output2);
  }
  const profile = { route: prefix.route, cwd: "/" };
  const launch = compileRoute(profile, `docker ps --no-trunc --format '${format}'`);
  const output = await runCaptured(launch.command, launch.args, signal);
  return parseDockerPs(output, prefix.normalized);
}
async function resolveDockerIdentity(parsed, signal) {
  const resolved = [];
  for (const layer of parsed.route) {
    if (layer.type === "ssh") {
      resolved.push(layer);
      continue;
    }
    const prefix = resolved.length > 0 ? {
      route: [...resolved],
      normalized: resolved.map((item) => item.type === "ssh" ? `ssh:${item.host}` : `docker:${item.container}`).join("|")
    } : void 0;
    const containers = await listDockerContainers(prefix, signal);
    const matches = containers.filter(
      (container) => container.name === layer.container || container.id === layer.container || container.id.startsWith(layer.container)
    );
    if (matches.length === 0) throw new Error(`Running Docker container not found: ${layer.container}`);
    if (matches.length > 1) throw new Error(`Docker container reference is ambiguous: ${layer.container}`);
    resolved.push({ ...layer, container: matches[0].id });
  }
  return {
    route: resolved,
    normalized: resolved.map((layer) => layer.type === "ssh" ? `ssh:${layer.host}` : `docker:${layer.container}`).join("|")
  };
}

// src/manager.ts
var CascadeManager = class {
  handles = /* @__PURE__ */ new Map();
  openingClients = /* @__PURE__ */ new Set();
  rememberedPinned = [];
  handleSequence = 0;
  stateFilePath;
  disconnecting = false;
  shuttingDown = false;
  constructor() {
    const configDir = path.join(homedir(), ".cascade-mcp");
    if (!existsSync2(configDir)) {
      try {
        mkdirSync2(configDir, { recursive: true });
      } catch {
      }
    }
    this.stateFilePath = path.join(configDir, "state.json");
    this.loadState();
  }
  loadState() {
    try {
      if (existsSync2(this.stateFilePath)) {
        const raw = readFileSync(this.stateFilePath, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.pinned)) {
          this.rememberedPinned = data.pinned;
        }
      }
    } catch {
    }
  }
  saveState() {
    try {
      writeFileSync2(this.stateFilePath, JSON.stringify({ version: 2, pinned: this.rememberedPinned }, null, 2), "utf8");
    } catch {
    }
  }
  connectionKey(persisted) {
    return `target:${persisted.target}:${persisted.cwd || ""}`;
  }
  remember(connection) {
    const key = this.connectionKey(connection);
    if (!this.rememberedPinned.some((item) => this.connectionKey(item) === key)) {
      this.rememberedPinned.push(connection);
      this.saveState();
    }
  }
  forget(targetString) {
    const parsed = parseTargetSpec(targetString);
    const initialLen = this.rememberedPinned.length;
    this.rememberedPinned = this.rememberedPinned.filter(
      (item) => item.target !== parsed.normalized && item.displayTarget !== parsed.normalized
    );
    const changed = this.rememberedPinned.length !== initialLen;
    if (changed) this.saveState();
    return changed;
  }
  getRemembered() {
    return [...this.rememberedPinned];
  }
  getHandles() {
    return [...this.handles.values()];
  }
  getHandle(id) {
    return this.handles.get(id);
  }
  acquireHandle(id) {
    const handle = this.handles.get(id);
    if (!handle) throw new Error(`Unknown Cascade handle: ${id}. Please open a target first.`);
    if (handle.state !== "ready") throw new Error(`Cascade handle ${id} is ${handle.state}`);
    handle.leases++;
    let released = false;
    return {
      handle,
      release: () => {
        if (released) return;
        released = true;
        handle.leases--;
        if (handle.leases === 0) {
          const waiters = handle.drainWaiters.splice(0);
          for (const resolve of waiters) resolve();
        }
      }
    };
  }
  async withHandle(id, action) {
    const lease = this.acquireHandle(id);
    try {
      return await action(lease.handle);
    } finally {
      lease.release();
    }
  }
  waitForDrain(handle) {
    if (handle.leases === 0) return Promise.resolve();
    return new Promise((resolve) => handle.drainWaiters.push(resolve));
  }
  async openTarget(target, options = {}) {
    if (this.shuttingDown) throw new Error("Cascade is shutting down");
    if (this.disconnecting) throw new Error("Cascade is disconnecting");
    const { cwd, mode = "pinned", password, signal, persist = true } = options;
    if (signal?.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");
    const requested = parseTargetSpec(target, { defaultPassword: password });
    const resolved = await resolveDockerIdentity(requested, signal);
    const profile = { route: resolved.route, cwd: cwd || "/" };
    const persisted = {
      kind: "target",
      target: resolved.normalized,
      displayTarget: requested.normalized !== resolved.normalized ? requested.normalized : void 0,
      cwd
    };
    const key = this.connectionKey(persisted);
    const existing = [...this.handles.values()].find((h) => h.key === key && h.state === "ready");
    if (existing) {
      if (mode === "pinned" && existing.mode !== "pinned") {
        existing.mode = "pinned";
        this.remember(existing.persisted);
      }
      return existing;
    }
    const client = new CascadeClient(requested.normalized, profile);
    this.openingClients.add(client);
    try {
      await client.start(signal);
      const bridge = await client.request({ op: "ping" }, { timeoutMs: 8e3, signal });
      const remoteCwd = cwd || bridge.cwd || bridge.home || "/";
      const handle = {
        id: `target-${++this.handleSequence}`,
        key,
        name: requested.normalized,
        mode,
        state: "ready",
        client,
        route: describeRoute(profile.route),
        remoteCwd,
        remoteHome: bridge.home,
        processControl: bridge.processControl ?? "pidfd",
        processControlDetail: bridge.processControlDetail,
        persisted,
        leases: 0,
        drainWaiters: [],
        closePromise: void 0
      };
      this.handles.set(handle.id, handle);
      if (mode === "pinned" && persist) {
        this.remember(persisted);
      }
      return handle;
    } finally {
      this.openingClients.delete(client);
    }
  }
  async closeHandle(id) {
    const handle = this.handles.get(id);
    if (!handle) throw new Error(`Unknown Cascade handle: ${id}`);
    if (handle.closePromise) return handle.closePromise;
    handle.state = "closing";
    handle.closePromise = (async () => {
      try {
        await this.waitForDrain(handle);
        await handle.client.close();
      } finally {
        this.handles.delete(id);
      }
    })();
    return handle.closePromise;
  }
  async closeAll() {
    this.disconnecting = true;
    try {
      await Promise.allSettled([...this.openingClients].map((c) => c.close()));
      await Promise.allSettled([...this.handles.keys()].map((id) => this.closeHandle(id)));
    } finally {
      this.disconnecting = false;
    }
  }
};

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// src/tools.ts
import path4 from "path";

// src/operations.ts
import path2 from "path";
var DEFAULT_MAX_BYTES = 50 * 1024;
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
function truncateLine(line, maxChars = 500) {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: line.slice(0, maxChars) + "...", wasTruncated: true };
}
function truncateHead(content, options) {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options?.maxLines ?? 2e3;
  const lines = content.split("\n");
  let truncated = false;
  let resultLines = lines;
  if (resultLines.length > maxLines) {
    resultLines = resultLines.slice(0, maxLines);
    truncated = true;
  }
  let text = resultLines.join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
    text = buf.toString("utf8");
    truncated = true;
  }
  return { content: text, truncated };
}
async function executeRemoteFind(client, toRemote, localCwd, params, signal) {
  const limit = Math.max(1, params.limit ?? 1e3);
  const searchPath = params.path || ".";
  const results = await client.request({
    op: "glob",
    path: toRemote(searchPath),
    pattern: params.pattern,
    ignore: ["**/node_modules/**", "**/.git/**"],
    limit
  }, { signal });
  if (results.length === 0) return { content: [{ type: "text", text: "No files found matching pattern" }], details: void 0 };
  const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const details = {};
  const notices = [];
  if (results.length >= limit) {
    details.resultLimitReached = limit;
    notices.push(`${limit} results limit reached`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  const text = notices.length ? `${truncation.content}

[${notices.join(". ")}]` : truncation.content;
  return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : void 0 };
}
async function executeRemoteGrep(client, toRemote, localCwd, params, signal) {
  const limit = Math.max(1, params.limit ?? 100);
  const searchPath = params.path || ".";
  const response = await client.request({
    op: "grep",
    path: toRemote(searchPath),
    pattern: params.pattern,
    glob: params.glob,
    ignoreCase: params.ignoreCase,
    literal: params.literal,
    context: params.context,
    limit
  }, { signal });
  if (response.matches.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: void 0 };
  let linesTruncated = false;
  const lines = response.matches.flatMap((block) => block.map((line) => {
    const truncated = truncateLine(line);
    if (truncated.wasTruncated) linesTruncated = true;
    return truncated.text;
  }));
  const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const details = {};
  const notices = [];
  if (response.limitReached) {
    details.matchLimitReached = limit;
    notices.push(`${limit} matches limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("long lines truncated");
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  const text = notices.length > 0 ? `${truncation.content}

[${notices.join(". ")}]` : truncation.content;
  return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : void 0 };
}

// src/transfer.ts
import { randomBytes as randomBytes2 } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { open, rename, rm, stat } from "fs/promises";
import path3 from "path";
import { PassThrough, Transform } from "stream";
import { pipeline } from "stream/promises";
import {
  constants as zlibConstants,
  createZstdCompress,
  createZstdDecompress,
  zstdCompressSync
} from "zlib";
var COPY_SAMPLE_SIZE = 256 * 1024;
var COPY_MIN_COMPRESSION_SIZE = 1024 * 1024;
var COPY_COMPRESSION_THRESHOLD = 0.9;
var PROGRESS_INTERVAL_MS = 250;
var zstdOptions = {
  params: {
    [zlibConstants.ZSTD_c_compressionLevel]: 1
  }
};
function ratio(logicalBytes, wireBytes) {
  return logicalBytes === 0 ? 1 : wireBytes / logicalBytes;
}
function progressReporter(callback) {
  let lastAt = 0;
  let lastLogicalBytes = 0;
  return (progress, force = false) => {
    const now = Date.now();
    const logicalStarted = lastLogicalBytes === 0 && progress.logicalBytes > 0;
    if (!force && !logicalStarted && now - lastAt < PROGRESS_INTERVAL_MS) return;
    lastAt = now;
    lastLogicalBytes = progress.logicalBytes;
    callback?.(progress);
  };
}
function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
async function selectLocalCopyCompression(localPath, size, requested) {
  if (requested === "none" || requested === "zstd") return requested;
  if (size < COPY_MIN_COMPRESSION_SIZE) return "none";
  const file = await open(localPath, "r");
  try {
    const sample = Buffer.allocUnsafe(Math.min(COPY_SAMPLE_SIZE, size));
    const { bytesRead } = await file.read(sample, 0, sample.length, 0);
    if (bytesRead === 0) return "none";
    const compressed = zstdCompressSync(sample.subarray(0, bytesRead), zstdOptions);
    return compressed.length <= bytesRead * COPY_COMPRESSION_THRESHOLD ? "zstd" : "none";
  } finally {
    await file.close();
  }
}
async function uploadLocalFile(client, localPath, remotePath, requestedCompression, options = {}) {
  const info = await stat(localPath);
  if (!info.isFile()) throw new Error(`Copy source is not a regular file: ${localPath}`);
  const compression = await selectLocalCopyCompression(localPath, info.size, requestedCompression);
  let logicalBytes = 0;
  let wireBytes = 0;
  const report = progressReporter(options.onProgress);
  const source = createReadStream(localPath, { signal: options.signal });
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      logicalBytes += chunk.length;
      report({ direction: "upload", compression, logicalBytes, wireBytes, totalLogicalBytes: info.size });
      callback(null, chunk);
    }
  });
  let stream = source.pipe(counter);
  const compressor = compression === "zstd" ? createZstdCompress(zstdOptions) : void 0;
  if (compressor) stream = stream.pipe(compressor);
  async function* chunks() {
    for await (const chunk of stream) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
  try {
    const result = await client.upload(
      {
        op: "copy_upload",
        path: remotePath,
        compression,
        mode: info.mode & 511
      },
      chunks(),
      {
        signal: options.signal,
        onWireChunk(bytes) {
          wireBytes += bytes;
          report({ direction: "upload", compression, logicalBytes, wireBytes, totalLogicalBytes: info.size });
        }
      }
    );
    if (result.logicalBytes !== info.size) {
      throw new Error(`Copy upload byte mismatch: expected ${info.size}, remote wrote ${result.logicalBytes}`);
    }
    report({
      direction: "upload",
      compression,
      logicalBytes: result.logicalBytes,
      wireBytes: result.wireBytes,
      totalLogicalBytes: info.size
    }, true);
    return { ...result, ratio: ratio(result.logicalBytes, result.wireBytes) };
  } finally {
    source.destroy();
    counter.destroy();
    compressor?.destroy();
  }
}
function waitForDrain(stream, signal) {
  if (signal.aborted) return Promise.reject(new Error(signal.reason ? String(signal.reason) : "aborted"));
  if (stream.destroyed) return Promise.reject(new Error("Copy download stream is closed"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener("drain", drained);
      stream.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => {
      cleanup();
      reject(new Error(signal.reason ? String(signal.reason) : "aborted"));
    };
    stream.once("drain", drained);
    stream.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
async function replaceLocalFile(tempPath, destination) {
  await rename(tempPath, destination);
}
async function downloadRemoteFile(client, remotePath, localPath, requestedCompression, options = {}) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const tempPath = path3.join(
    path3.dirname(localPath),
    `.${path3.basename(localPath)}.pi-cascade-${process.pid}-${randomBytes2(6).toString("hex")}.part`
  );
  const input = new PassThrough({ highWaterMark: 256 * 1024 });
  let metadata;
  let transferPipeline;
  let drainWait;
  let logicalBytes = 0;
  let wireBytes = 0;
  let committed = false;
  const report = progressReporter(options.onProgress);
  try {
    const result = await client.request(
      { op: "copy_download", path: remotePath, compression: requestedCompression },
      {
        signal,
        onMeta(value) {
          const candidate = value;
          if (candidate?.compression !== "none" && candidate?.compression !== "zstd" || typeof candidate.logicalBytes !== "number" || typeof candidate.mode !== "number") {
            controller.abort("Invalid copy download metadata");
            return;
          }
          metadata = candidate;
          const output = createWriteStream(tempPath, { flags: "wx", mode: 384 });
          const counter = new Transform({
            transform(chunk, _encoding, callback) {
              logicalBytes += chunk.length;
              report({
                direction: "download",
                compression: metadata.compression,
                logicalBytes,
                wireBytes,
                totalLogicalBytes: metadata.logicalBytes
              });
              callback(null, chunk);
            }
          });
          transferPipeline = metadata.compression === "zstd" ? pipeline(input, createZstdDecompress(), counter, output, { signal }) : pipeline(input, counter, output, { signal });
          void transferPipeline.catch((error) => controller.abort(error));
        },
        onData(data, stream) {
          if (stream !== "content") return;
          if (!metadata || !transferPipeline) {
            const error = new Error("Copy download data arrived before metadata");
            controller.abort(error);
            return Promise.reject(error);
          }
          wireBytes += data.length;
          report({
            direction: "download",
            compression: metadata.compression,
            logicalBytes,
            wireBytes,
            totalLogicalBytes: metadata.logicalBytes
          });
          if (input.write(data)) return;
          drainWait ??= waitForDrain(input, signal).finally(() => {
            drainWait = void 0;
          });
          return drainWait;
        }
      }
    );
    if (!metadata || !transferPipeline) throw new Error("Copy download completed without metadata");
    input.end();
    await transferPipeline;
    signal.throwIfAborted();
    if (result.compression !== metadata.compression) {
      throw new Error(`Copy download compression mismatch: metadata=${metadata.compression}, result=${result.compression}`);
    }
    if (logicalBytes !== metadata.logicalBytes || logicalBytes !== result.logicalBytes) {
      throw new Error(`Copy download byte mismatch: expected ${metadata.logicalBytes}, wrote ${logicalBytes}`);
    }
    const completedFile = await open(tempPath, "r+");
    try {
      await completedFile.sync();
      await completedFile.chmod(metadata.mode & 511);
      await completedFile.sync();
    } finally {
      await completedFile.close();
    }
    signal.throwIfAborted();
    await replaceLocalFile(tempPath, localPath);
    committed = true;
    report({
      direction: "download",
      compression: metadata.compression,
      logicalBytes: result.logicalBytes,
      wireBytes: result.wireBytes,
      totalLogicalBytes: metadata.logicalBytes
    }, true);
    return { ...result, ratio: ratio(result.logicalBytes, result.wireBytes) };
  } catch (error) {
    const normalized = normalizeError(error);
    controller.abort(normalized);
    input.destroy(normalized);
    await transferPipeline?.catch(() => void 0);
    throw normalized;
  } finally {
    input.destroy();
    if (!committed) await rm(tempPath, { force: true }).catch(() => void 0);
  }
}

// src/tools.ts
function resolveRemotePath(inputPath, remoteCwd) {
  const normalized = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("\\") || /^\/\/[^/]/.test(normalized)) {
    throw new Error(`Refusing local Windows absolute path for a remote tool: ${inputPath}. Use a target-relative or POSIX path.`);
  }
  if (normalized.startsWith("/")) {
    return path4.posix.normalize(normalized);
  }
  return path4.posix.normalize(path4.posix.join(remoteCwd, normalized));
}
async function handleTargetAction(manager, params, signal) {
  if (params.action === "list") {
    const prefix = params.host ? parseTargetSpec(params.host.startsWith("ssh:") || params.host.startsWith("ssh://") ? params.host : `ssh:${params.host}`) : void 0;
    const containers = await listDockerContainers(prefix, signal);
    if (containers.length === 0) {
      return { content: [{ type: "text", text: "No running Docker containers found." }] };
    }
    const text = containers.map((item, index) => [
      `${index + 1}. ${item.name} (${item.id.slice(0, 12)})`,
      `   image=${item.image}`,
      `   status=${item.status}`,
      `   target=${item.connectionTarget}`
    ].join("\n")).join("\n");
    return { content: [{ type: "text", text }] };
  }
  if (params.action === "open") {
    if (!params.target) throw new Error("target is required for action=open");
    const opened = await manager.openTarget(params.target, {
      cwd: params.cwd,
      mode: params.mode ?? "pinned",
      password: params.password,
      signal
    });
    const text = [
      `Opened ${opened.id}: ${opened.name}`,
      `Route: ${opened.route}`,
      `CWD: ${opened.remoteCwd}`,
      `Mode: ${opened.mode}`,
      `Process control: ${opened.processControl}`,
      opened.processControl === "procfs-fallback" ? "Warning: old-kernel fallback verifies /proc identity before PID signaling but cannot provide pidfd race-free guarantee." : "Process cancellation uses instance-bound pidfds.",
      `Ready for remote tools: cascade_remote_read, cascade_remote_write, cascade_remote_edit, cascade_remote_bash, cascade_remote_ls, cascade_remote_find, cascade_remote_grep, cascade_remote_copy`,
      `Use handle="${opened.id}" in subsequent remote operations.`
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
  if (params.action === "close") {
    let id = params.handle;
    if (!id) {
      const handles2 = manager.getHandles();
      if (handles2.length !== 1) throw new Error(`handle is required when ${handles2.length} targets are open`);
      id = handles2[0].id;
    }
    await manager.closeHandle(id);
    return { content: [{ type: "text", text: `Closed ${id}.` }] };
  }
  if (params.action === "disconnect") {
    await manager.closeAll();
    return { content: [{ type: "text", text: "Closed all Cascade handles." }] };
  }
  if (params.action === "forget") {
    if (!params.target) throw new Error("target is required for action=forget");
    const changed = manager.forget(params.target);
    if (!changed) throw new Error(`Remembered target not found: ${params.target}`);
    return { content: [{ type: "text", text: `Forgot pinned target: ${params.target}` }] };
  }
  const handles = manager.getHandles();
  const remembered = manager.getRemembered();
  const openText = handles.length > 0 ? `Open Cascade handles:
${handles.map((h) => `${h.id}=${h.name} (${h.state}, ${h.mode}, cwd=${h.remoteCwd}, route=${h.route})`).join("\n")}` : "No open Cascade handles.";
  const rememberedText = remembered.length > 0 ? `

Remembered pinned targets:
${remembered.map((item) => JSON.stringify(item)).join("\n")}` : "";
  return { content: [{ type: "text", text: openText + rememberedText }] };
}
async function handleRemoteRead(manager, params, signal) {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path, handle.remoteCwd);
    const res = await handle.client.request({
      op: "read",
      path: targetRemotePath
    }, { signal });
    const fullText = Buffer.from(res.data, "base64").toString("utf8");
    const lines = fullText.split("\n");
    if (params.offset !== void 0 || params.limit !== void 0) {
      const offset = Math.max(1, params.offset ?? 1);
      const limit = params.limit ?? lines.length;
      const startIdx = offset - 1;
      const selectedLines = lines.slice(startIdx, startIdx + limit);
      const numbered = selectedLines.map((line, i) => `${startIdx + i + 1} | ${line}`).join("\n");
      return { content: [{ type: "text", text: numbered }] };
    }
    const truncation = truncateHead(fullText);
    let output = truncation.content;
    if (truncation.truncated) {
      output += `

[File content truncated at ${formatSize(DEFAULT_MAX_BYTES)}. Use offset & limit to read remaining lines]`;
    }
    return { content: [{ type: "text", text: output }] };
  });
}
async function handleRemoteWrite(manager, params, signal) {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path, handle.remoteCwd);
    const dir = path4.posix.dirname(targetRemotePath);
    if (dir && dir !== "." && dir !== "/") {
      await handle.client.request({ op: "mkdir", path: dir }, { signal });
    }
    const data = Buffer.from(params.content, "utf8").toString("base64");
    await handle.client.request({ op: "write", path: targetRemotePath, data }, { signal });
    const bytes = Buffer.byteLength(params.content, "utf8");
    return { content: [{ type: "text", text: `Successfully wrote ${formatSize(bytes)} to ${params.path}` }] };
  });
}
async function handleRemoteEdit(manager, params, signal) {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path, handle.remoteCwd);
    const res = await handle.client.request({ op: "read", path: targetRemotePath }, { signal });
    let currentContent = Buffer.from(res.data, "base64").toString("utf8");
    for (let i = 0; i < params.edits.length; i++) {
      const { oldText, newText } = params.edits[i];
      const count = currentContent.split(oldText).length - 1;
      if (count === 0) {
        throw new Error(`Edit failed: oldText for edit #${i + 1} was not found in ${params.path}`);
      }
      if (count > 1) {
        throw new Error(`Edit failed: oldText for edit #${i + 1} is ambiguous (${count} occurrences found). Include more surrounding context.`);
      }
      currentContent = currentContent.replace(oldText, newText);
    }
    const data = Buffer.from(currentContent, "utf8").toString("base64");
    await handle.client.request({ op: "write", path: targetRemotePath, data }, { signal });
    return { content: [{ type: "text", text: `Successfully applied ${params.edits.length} edit(s) to ${params.path}` }] };
  });
}
async function handleRemoteBash(manager, params, signal) {
  return manager.withHandle(params.handle, async (handle) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;
    const maxAllowedBytes = 1024 * 1024;
    const timeoutMs = params.timeout ? params.timeout * 1e3 : void 0;
    const res = await handle.client.request({
      op: "exec",
      command: params.command,
      cwd: handle.remoteCwd
    }, {
      signal,
      timeoutMs,
      onData(chunk, stream) {
        if (totalBytes < maxAllowedBytes) {
          if (stream === "stdout") stdoutChunks.push(chunk);
          else if (stream === "stderr") stderrChunks.push(chunk);
          totalBytes += chunk.length;
        }
      }
    });
    const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
    const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");
    const stdoutTrunc = truncateHead(stdoutRaw, { maxBytes: 50 * 1024 });
    const stderrTrunc = truncateHead(stderrRaw, { maxBytes: 20 * 1024 });
    let output = "";
    if (stdoutTrunc.content) {
      output += `[stdout]
${stdoutTrunc.content}`;
      if (stdoutTrunc.truncated) output += "\n[stdout truncated]";
    }
    if (stderrTrunc.content) {
      if (output) output += "\n\n";
      output += `[stderr]
${stderrTrunc.content}`;
      if (stderrTrunc.truncated) output += "\n[stderr truncated]";
    }
    if (!output) output = "(No output)";
    output += `

[Process exited with code ${res.exitCode}]`;
    return { content: [{ type: "text", text: output }], isError: res.exitCode !== 0 };
  });
}
async function handleRemoteLs(manager, params, signal) {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path ?? ".", handle.remoteCwd);
    const names = await handle.client.request({ op: "readdir", path: targetRemotePath }, { signal });
    const limit = Math.max(1, params.limit ?? 500);
    const itemsToProcess = names.slice(0, limit);
    const entries = await Promise.all(
      itemsToProcess.map(async (name) => {
        try {
          const fullEntryPath = path4.posix.join(targetRemotePath, name);
          const st = await handle.client.request({ op: "stat", path: fullEntryPath }, { signal });
          return { name, isDir: st.isDirectory, size: st.size };
        } catch {
          return { name, isDir: false, size: 0 };
        }
      })
    );
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const lines = entries.map((e) => {
      const typeStr = e.isDir ? "[DIR] " : "      ";
      const sizeStr = e.isDir ? "" : ` (${formatSize(e.size)})`;
      return `${typeStr} ${e.name}${sizeStr}`;
    });
    let text = lines.join("\n");
    if (names.length > limit) {
      text += `

[Showing ${limit} of ${names.length} items. Increase limit to view more]`;
    }
    return { content: [{ type: "text", text: text || "(Empty directory)" }] };
  });
}
async function handleRemoteFind(manager, params, signal) {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path ?? ".", handle.remoteCwd);
    return executeRemoteFind(
      handle.client,
      (p) => resolveRemotePath(p, handle.remoteCwd),
      process.cwd(),
      { pattern: params.pattern, path: targetRemotePath, limit: params.limit },
      signal
    );
  });
}
async function handleRemoteGrep(manager, params, signal) {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path ?? ".", handle.remoteCwd);
    return executeRemoteGrep(
      handle.client,
      (p) => resolveRemotePath(p, handle.remoteCwd),
      process.cwd(),
      {
        pattern: params.pattern,
        path: targetRemotePath,
        glob: params.glob,
        ignoreCase: params.ignoreCase,
        literal: params.literal,
        context: params.context,
        limit: params.limit
      },
      signal
    );
  });
}
async function handleRemoteCopy(manager, params, signal) {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.remotePath, handle.remoteCwd);
    const localPath = path4.resolve(process.cwd(), params.localPath.startsWith("@") ? params.localPath.slice(1) : params.localPath);
    const compression = params.compression ?? "auto";
    if (params.direction === "upload") {
      const parentDir = path4.posix.dirname(targetRemotePath);
      if (parentDir && parentDir !== "." && parentDir !== "/") {
        try {
          await handle.client.request({ op: "mkdir", path: parentDir }, { signal });
        } catch {
        }
      }
    }
    const result = params.direction === "upload" ? await uploadLocalFile(handle.client, localPath, targetRemotePath, compression, { signal }) : await downloadRemoteFile(handle.client, targetRemotePath, localPath, compression, { signal });
    const ratio2 = `${(result.ratio * 100).toFixed(1)}%`;
    const verb = params.direction === "upload" ? "Uploaded" : "Downloaded";
    const source = params.direction === "upload" ? localPath : `${handle.id}:${params.remotePath}`;
    const destination = params.direction === "upload" ? `${handle.id}:${params.remotePath}` : localPath;
    const text = `${verb} ${source} \u2192 ${destination}
${formatSize(result.logicalBytes)} logical, ${formatSize(result.wireBytes)} on wire (${result.compression}, ${ratio2})`;
    return { content: [{ type: "text", text }] };
  });
}

// src/server.ts
function createCascadeMcpServer(manager = new CascadeManager()) {
  const server = new McpServer({
    name: "cascade-mcp",
    version: "0.1.0"
  });
  server.tool(
    "cascade_target",
    "Discover, connect, and manage Docker and SSH targets without manual agent setup. Use action=list to inspect running Docker containers. Use action=open to establish a live connection to a container, SSH host, or nested target chain, returning a target handle. Use action=handles or action=status to inspect active connections and remembered targets. Use action=close to close a specific handle, or action=disconnect to close all handles. Use action=forget to remove a remembered pinned target.",
    {
      action: z.enum(["list", "open", "handles", "status", "close", "forget", "disconnect"]),
      target: z.string().optional(),
      password: z.string().optional(),
      host: z.string().optional(),
      cwd: z.string().optional(),
      handle: z.string().optional(),
      mode: z.enum(["transient", "pinned"]).optional()
    },
    async (params, extra) => {
      try {
        return await handleTargetAction(manager, params, extra.signal);
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    }
  );
  server.tool(
    "cascade_remote_read",
    "Read a file from an opened remote target. Requires a READY handle returned by cascade_target open. Supports offset & limit with line numbers.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      path: z.string().describe("Remote file path"),
      offset: z.number().int().min(1).optional().describe("Starting line number (1-based)"),
      limit: z.number().int().min(1).optional().describe("Number of lines to read")
    },
    async (params, extra) => {
      try {
        return await handleRemoteRead(manager, params, extra.signal);
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    }
  );
  server.tool(
    "cascade_remote_write",
    "Write content to a file on an opened remote target. Requires a READY handle. Automatically creates parent directories.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      path: z.string().describe("Remote file path"),
      content: z.string().describe("Content to write into the file")
    },
    async (params, extra) => {
      try {
        return await handleRemoteWrite(manager, params, extra.signal);
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    }
  );
  server.tool(
    "cascade_remote_edit",
    "Apply exact text replacements to a file on an opened remote target. Requires a READY handle. Each edit must specify oldText and newText.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      path: z.string().describe("Remote file path"),
      edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1)
    },
    async (params, extra) => {
      try {
        return await handleRemoteEdit(manager, params, extra.signal);
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    }
  );
  server.tool(
    "cascade_remote_bash",
    "Execute a shell command on an opened remote target. Returns stdout, stderr, and exit code. Supports execution timeout in seconds. Cancellation cleanly kills child process trees using pidfd/procfs.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      command: z.string().describe("Shell command to run on target"),
      timeout: z.number().positive().optional().describe("Execution timeout in seconds")
    },
    async (params, extra) => {
      try {
        return await handleRemoteBash(manager, params, extra.signal);
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    }
  );
  server.tool(
    "cascade_remote_ls",
    "List directory entries on an opened remote target. Returns item names, types (DIR/FILE), and sizes.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      path: z.string().optional().describe("Directory path on remote target"),
      limit: z.number().int().min(1).optional().describe("Maximum number of entries to return (default: 500)")
    },
    async (params, extra) => {
      try {
        return await handleRemoteLs(manager, params, extra.signal);
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    }
  );
  server.tool(
    "cascade_remote_find",
    "Find files matching a glob pattern on an opened remote target. Requires a READY handle.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      pattern: z.string().describe("Glob pattern"),
      path: z.string().optional().describe("Directory to search in"),
      limit: z.number().int().min(1).optional().describe("Maximum results to return")
    },
    async (params, extra) => {
      try {
        return await handleRemoteFind(manager, params, extra.signal);
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    }
  );
  server.tool(
    "cascade_remote_grep",
    "Search text content within files on an opened remote target. Requires a READY handle.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      pattern: z.string().describe("Regex or literal text to search for"),
      path: z.string().optional().describe("Directory or file to search in"),
      glob: z.string().optional().describe("Glob pattern filter"),
      ignoreCase: z.boolean().optional(),
      literal: z.boolean().optional(),
      context: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional()
    },
    async (params, extra) => {
      try {
        return await handleRemoteGrep(manager, params, extra.signal);
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    }
  );
  server.tool(
    "cascade_remote_copy",
    "Stream transfer a regular file between local machine and opened remote target. Supports zstd compression.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      direction: z.enum(["upload", "download"]).describe("upload: local->remote; download: remote->local"),
      localPath: z.string().describe("Local file path"),
      remotePath: z.string().describe("Remote file path"),
      compression: z.enum(["auto", "none", "zstd"]).optional()
    },
    async (params, extra) => {
      try {
        return await handleRemoteCopy(manager, params, extra.signal);
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    }
  );
  return server;
}

// src/cli.ts
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write("Cascade MCP Server - Zero-config dynamic SSH and Docker remote access\n");
    process.stderr.write("Usage: npx -y github:cheng6563/cascade-mcp\n");
    process.stderr.write("This is an MCP server communicating over standard I/O (stdio).\n");
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stderr.write("0.1.0\n");
    process.exit(0);
  }
  const manager = new CascadeManager();
  const server = createCascadeMcpServer(manager);
  const transport = new StdioServerTransport();
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    try {
      await manager.closeAll();
    } catch {
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  await server.connect(transport);
}
main().catch((err) => {
  process.stderr.write(`Cascade MCP server fatal error: ${err?.stack || err}
`);
  process.exit(1);
});
//# sourceMappingURL=cli.js.map