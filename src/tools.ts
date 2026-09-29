import path from "node:path";
import { CascadeManager, type RuntimeHandle } from "./manager.js";
import { DEFAULT_MAX_BYTES, executeRemoteFind, executeRemoteGrep, formatSize, truncateHead } from "./operations.js";
import { listDockerContainers, parseTargetSpec } from "./target.js";
import { downloadRemoteFile, uploadLocalFile } from "./transfer.js";
import type { CopyCompression } from "./types.js";

export function resolveRemotePath(inputPath: string, remoteCwd: string): string {
  const normalized = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("\\") || /^\/\/[^/]/.test(normalized)) {
    throw new Error(`Refusing local Windows absolute path for a remote tool: ${inputPath}. Use a target-relative or POSIX path.`);
  }
  if (normalized.startsWith("/")) {
    return path.posix.normalize(normalized);
  }
  return path.posix.normalize(path.posix.join(remoteCwd, normalized));
}

export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handleTargetAction(
  manager: CascadeManager,
  params: {
    action: "list" | "open" | "handles" | "status" | "close" | "forget" | "disconnect";
    target?: string;
    password?: string;
    host?: string;
    cwd?: string;
    handle?: string;
    mode?: "transient" | "pinned";
  },
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (params.action === "list") {
    const prefix = params.host
      ? parseTargetSpec(params.host.startsWith("ssh:") || params.host.startsWith("ssh://") ? params.host : `ssh:${params.host}`)
      : undefined;
    const containers = await listDockerContainers(prefix, signal);
    if (containers.length === 0) {
      return { content: [{ type: "text", text: "No running Docker containers found." }] };
    }
    const text = containers.map((item, index) => [
      `${index + 1}. ${item.name} (${item.id.slice(0, 12)})`,
      `   image=${item.image}`,
      `   status=${item.status}`,
      `   target=${item.connectionTarget}`,
    ].join("\n")).join("\n");
    return { content: [{ type: "text", text }] };
  }

  if (params.action === "open") {
    if (!params.target) throw new Error("target is required for action=open");
    const opened = await manager.openTarget(params.target, {
      cwd: params.cwd,
      mode: params.mode ?? "pinned",
      password: params.password,
      signal,
    });
    const text = [
      `Opened ${opened.id}: ${opened.name}`,
      `Route: ${opened.route}`,
      `CWD: ${opened.remoteCwd}`,
      `Mode: ${opened.mode}`,
      `Process control: ${opened.processControl}`,
      opened.processControl === "procfs-fallback"
        ? "Warning: old-kernel fallback verifies /proc identity before PID signaling but cannot provide pidfd race-free guarantee."
        : "Process cancellation uses instance-bound pidfds.",
      `Ready for remote tools: cascade_remote_read, cascade_remote_write, cascade_remote_edit, cascade_remote_bash, cascade_remote_ls, cascade_remote_find, cascade_remote_grep, cascade_remote_copy`,
      `Use handle="${opened.id}" in subsequent remote operations.`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }

  if (params.action === "close") {
    let id = params.handle;
    if (!id) {
      const handles = manager.getHandles();
      if (handles.length !== 1) throw new Error(`handle is required when ${handles.length} targets are open`);
      id = handles[0]!.id;
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
  const openText = handles.length > 0
    ? `Open Cascade handles:\n${handles.map((h) => `${h.id}=${h.name} (${h.state}, ${h.mode}, cwd=${h.remoteCwd}, route=${h.route})`).join("\n")}`
    : "No open Cascade handles.";
  const rememberedText = remembered.length > 0
    ? `\n\nRemembered pinned targets:\n${remembered.map((item) => JSON.stringify(item)).join("\n")}`
    : "";
  return { content: [{ type: "text", text: openText + rememberedText }] };
}

export async function handleRemoteRead(
  manager: CascadeManager,
  params: { handle: string; path: string; offset?: number; limit?: number },
  signal?: AbortSignal,
): Promise<ToolResult> {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path, handle.remoteCwd);
    const res = await handle.client.request<{ data: string; mime?: string | null }>({
      op: "read",
      path: targetRemotePath,
    }, { signal });
    const fullText = Buffer.from(res.data, "base64").toString("utf8");
    const lines = fullText.split("\n");

    if (params.offset !== undefined || params.limit !== undefined) {
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
      output += `\n\n[File content truncated at ${formatSize(DEFAULT_MAX_BYTES)}. Use offset & limit to read remaining lines]`;
    }
    return { content: [{ type: "text", text: output }] };
  });
}

export async function handleRemoteWrite(
  manager: CascadeManager,
  params: { handle: string; path: string; content: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path, handle.remoteCwd);
    const dir = path.posix.dirname(targetRemotePath);
    if (dir && dir !== "." && dir !== "/") {
      await handle.client.request({ op: "mkdir", path: dir }, { signal });
    }
    const data = Buffer.from(params.content, "utf8").toString("base64");
    await handle.client.request({ op: "write", path: targetRemotePath, data }, { signal });
    const bytes = Buffer.byteLength(params.content, "utf8");
    return { content: [{ type: "text", text: `Successfully wrote ${formatSize(bytes)} to ${params.path}` }] };
  });
}

export async function handleRemoteEdit(
  manager: CascadeManager,
  params: { handle: string; path: string; edits: Array<{ oldText: string; newText: string }> },
  signal?: AbortSignal,
): Promise<ToolResult> {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path, handle.remoteCwd);
    const res = await handle.client.request<{ data: string }>({ op: "read", path: targetRemotePath }, { signal });
    let currentContent = Buffer.from(res.data, "base64").toString("utf8");

    for (let i = 0; i < params.edits.length; i++) {
      const { oldText, newText } = params.edits[i]!;
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

export async function handleRemoteBash(
  manager: CascadeManager,
  params: { handle: string; command: string; timeout?: number },
  signal?: AbortSignal,
): Promise<ToolResult> {
  return manager.withHandle(params.handle, async (handle) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    const maxAllowedBytes = 1024 * 1024;
    const timeoutMs = params.timeout ? params.timeout * 1000 : undefined;

    const res = await handle.client.request<{ exitCode: number }>({
      op: "exec",
      command: params.command,
      cwd: handle.remoteCwd,
    }, {
      signal,
      timeoutMs,
      onData(chunk, stream) {
        if (totalBytes < maxAllowedBytes) {
          if (stream === "stdout") stdoutChunks.push(chunk);
          else if (stream === "stderr") stderrChunks.push(chunk);
          totalBytes += chunk.length;
        }
      },
    });

    const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
    const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");
    const stdoutTrunc = truncateHead(stdoutRaw, { maxBytes: 50 * 1024 });
    const stderrTrunc = truncateHead(stderrRaw, { maxBytes: 20 * 1024 });

    let output = "";
    if (stdoutTrunc.content) {
      output += `[stdout]\n${stdoutTrunc.content}`;
      if (stdoutTrunc.truncated) output += "\n[stdout truncated]";
    }
    if (stderrTrunc.content) {
      if (output) output += "\n\n";
      output += `[stderr]\n${stderrTrunc.content}`;
      if (stderrTrunc.truncated) output += "\n[stderr truncated]";
    }
    if (!output) output = "(No output)";
    output += `\n\n[Process exited with code ${res.exitCode}]`;

    return { content: [{ type: "text", text: output }], isError: res.exitCode !== 0 };
  });
}

export async function handleRemoteLs(
  manager: CascadeManager,
  params: { handle: string; path?: string; limit?: number },
  signal?: AbortSignal,
): Promise<ToolResult> {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path ?? ".", handle.remoteCwd);
    const names = await handle.client.request<string[]>({ op: "readdir", path: targetRemotePath }, { signal });
    const limit = Math.max(1, params.limit ?? 500);
    const itemsToProcess = names.slice(0, limit);

    const entries = await Promise.all(
      itemsToProcess.map(async (name) => {
        try {
          const fullEntryPath = path.posix.join(targetRemotePath, name);
          const st = await handle.client.request<{ isDirectory: boolean; size: number }>({ op: "stat", path: fullEntryPath }, { signal });
          return { name, isDir: st.isDirectory, size: st.size };
        } catch {
          return { name, isDir: false, size: 0 };
        }
      }),
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
      text += `\n\n[Showing ${limit} of ${names.length} items. Increase limit to view more]`;
    }
    return { content: [{ type: "text", text: text || "(Empty directory)" }] };
  });
}

export async function handleRemoteFind(
  manager: CascadeManager,
  params: { handle: string; pattern: string; path?: string; limit?: number },
  signal?: AbortSignal,
): Promise<ToolResult> {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.path ?? ".", handle.remoteCwd);
    return executeRemoteFind(
      handle.client,
      (p) => resolveRemotePath(p, handle.remoteCwd),
      process.cwd(),
      { pattern: params.pattern, path: targetRemotePath, limit: params.limit },
      signal,
    );
  });
}

export async function handleRemoteGrep(
  manager: CascadeManager,
  params: {
    handle: string;
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<ToolResult> {
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
        limit: params.limit,
      },
      signal,
    );
  });
}

export async function handleRemoteCopy(
  manager: CascadeManager,
  params: {
    handle: string;
    direction: "upload" | "download";
    localPath: string;
    remotePath: string;
    compression?: CopyCompression;
  },
  signal?: AbortSignal,
): Promise<ToolResult> {
  return manager.withHandle(params.handle, async (handle) => {
    const targetRemotePath = resolveRemotePath(params.remotePath, handle.remoteCwd);
    const localPath = path.resolve(process.cwd(), params.localPath.startsWith("@") ? params.localPath.slice(1) : params.localPath);
    const compression = params.compression ?? "auto";

    if (params.direction === "upload") {
      const parentDir = path.posix.dirname(targetRemotePath);
      if (parentDir && parentDir !== "." && parentDir !== "/") {
        try {
          await handle.client.request({ op: "mkdir", path: parentDir }, { signal });
        } catch {}
      }
    }
    const result = params.direction === "upload"
      ? await uploadLocalFile(handle.client, localPath, targetRemotePath, compression, { signal })
      : await downloadRemoteFile(handle.client, targetRemotePath, localPath, compression, { signal });

    const ratio = `${(result.ratio * 100).toFixed(1)}%`;
    const verb = params.direction === "upload" ? "Uploaded" : "Downloaded";
    const source = params.direction === "upload" ? localPath : `${handle.id}:${params.remotePath}`;
    const destination = params.direction === "upload" ? `${handle.id}:${params.remotePath}` : localPath;
    const text = `${verb} ${source} → ${destination}\n${formatSize(result.logicalBytes)} logical, ${formatSize(result.wireBytes)} on wire (${result.compression}, ${ratio})`;
    return { content: [{ type: "text", text }] };
  });
}
