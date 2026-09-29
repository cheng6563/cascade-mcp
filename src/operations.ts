import path from "node:path";
import type { CascadeClient } from "./client.js";

export const DEFAULT_MAX_BYTES = 50 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function truncateLine(line: string, maxChars = 500): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: line.slice(0, maxChars) + "...", wasTruncated: true };
}

export function truncateHead(content: string, options?: { maxLines?: number; maxBytes?: number }): { content: string; truncated: boolean } {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options?.maxLines ?? 2000;
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

export function inside(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createPathMapper(localCwd: string, remoteCwd: string, remoteHome?: string): (value: string) => string {
  return (value: string) => {
    const normalized = path.resolve(value);
    if (inside(localCwd, normalized)) {
      const relative = path.relative(localCwd, normalized).split(path.sep).join("/");
      return relative ? path.posix.join(remoteCwd, relative) : remoteCwd;
    }
    const localHome = process.env.USERPROFILE || process.env.HOME;
    if (remoteHome && localHome && inside(path.resolve(localHome), normalized)) {
      const relative = path.relative(path.resolve(localHome), normalized).split(path.sep).join("/");
      return relative ? path.posix.join(remoteHome, relative) : remoteHome;
    }
    const withoutDrive = normalized.replace(/^[A-Za-z]:[\/]/, "/").replaceAll("\\", "/");
    return path.posix.normalize(withoutDrive.startsWith("/") ? withoutDrive : `/${withoutDrive}`);
  };
}

export interface FindToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export interface FindToolDetails {
  resultLimitReached?: number;
  truncation?: { content: string; truncated: boolean };
}

export interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export interface GrepToolDetails {
  matchLimitReached?: number;
  linesTruncated?: boolean;
  truncation?: { content: string; truncated: boolean };
}

interface ReadResponse { data: string; mime?: string | null }
interface StatResponse { isDirectory: boolean; size: number }
interface GrepResponse { matches: string[][]; limitReached: boolean }

export function createRemoteOperations(
  client: CascadeClient,
  localCwd: string,
  remoteCwd: string,
  remoteHome?: string,
  signal?: AbortSignal,
) {
  const remote = createPathMapper(localCwd, remoteCwd, remoteHome);

  const read = {
    async readFile(filePath: string): Promise<Buffer> {
      const response = await client.request<ReadResponse>({ op: "read", path: remote(filePath) }, { signal });
      return Buffer.from(response.data, "base64");
    },
    async access(filePath: string): Promise<void> {
      await client.request({ op: "access", path: remote(filePath), mode: 4 }, { signal });
    },
    async detectImageMimeType(filePath: string): Promise<string | null> {
      const response = await client.request<{ mime?: string | null }>({ op: "mime", path: remote(filePath) }, { signal });
      return response.mime?.startsWith("image/") ? response.mime : null;
    },
  };

  const write = {
    async writeFile(filePath: string, content: string | Buffer): Promise<void> {
      const data = Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(content, "utf8").toString("base64");
      await client.request({ op: "write", path: remote(filePath), data }, { signal });
    },
    async mkdir(dirPath: string): Promise<void> {
      await client.request({ op: "mkdir", path: remote(dirPath) }, { signal });
    },
  };

  const ls = {
    async exists(filePath: string): Promise<boolean> {
      try {
        await client.request({ op: "access", path: remote(filePath), mode: 0 }, { signal });
        return true;
      } catch {
        return false;
      }
    },
    async stat(filePath: string): Promise<StatResponse> {
      return client.request<StatResponse>({ op: "stat", path: remote(filePath) }, { signal });
    },
    async readdir(dirPath: string): Promise<string[]> {
      return client.request<string[]>({ op: "readdir", path: remote(dirPath) }, { signal });
    },
  };

  const bash = {
    async exec(command: string, cwd: string, options: {
      timeout?: number;
      env?: Record<string, string>;
      signal?: AbortSignal;
      onData?: (data: Buffer, stream: "stdout" | "stderr" | "content") => unknown;
    }) {
      const timeout = options.timeout;
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
      }
      const timeoutMs = timeout === undefined ? undefined : timeout * 1000;
      const response = await client.request<{ exitCode: number }>({ op: "exec", command, cwd: remote(cwd), env: options.env }, {
        signal: options.signal ?? signal,
        timeoutMs,
        onData: (data, stream) => options.onData?.(data, stream),
      });
      return { exitCode: response.exitCode };
    },
  };

  return { read, write, ls, bash, remote };
}

export async function executeRemoteFind(
  client: CascadeClient,
  toRemote: (value: string) => string,
  localCwd: string,
  params: FindToolInput,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: FindToolDetails | undefined }> {
  const limit = Math.max(1, params.limit ?? 1000);
  const searchPath = params.path || ".";
  const results = await client.request<string[]>({
    op: "glob",
    path: toRemote(searchPath),
    pattern: params.pattern,
    ignore: ["**/node_modules/**", "**/.git/**"],
    limit,
  }, { signal });
  if (results.length === 0) return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
  const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const details: FindToolDetails = {};
  const notices: string[] = [];
  if (results.length >= limit) {
    details.resultLimitReached = limit;
    notices.push(`${limit} results limit reached`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  const text = notices.length ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
  return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}

export async function executeRemoteGrep(
  client: CascadeClient,
  toRemote: (value: string) => string,
  localCwd: string,
  params: GrepToolInput,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined }> {
  const limit = Math.max(1, params.limit ?? 100);
  const searchPath = params.path || ".";
  const response = await client.request<GrepResponse>({
    op: "grep",
    path: toRemote(searchPath),
    pattern: params.pattern,
    glob: params.glob,
    ignoreCase: params.ignoreCase,
    literal: params.literal,
    context: params.context,
    limit,
  }, { signal });

  if (response.matches.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  let linesTruncated = false;
  const lines = response.matches.flatMap((block) => block.map((line) => {
    const truncated = truncateLine(line);
    if (truncated.wasTruncated) linesTruncated = true;
    return truncated.text;
  }));
  const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const details: GrepToolDetails = {};
  const notices: string[] = [];
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
  const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
  return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}
