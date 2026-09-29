import { spawn } from "node:child_process";
import { compileRoute } from "./route.js";
import type { DockerLayer, RouteLayer, RouteSpec, SshLayer } from "./types.js";

export interface ParsedTarget {
  normalized: string;
  route: RouteLayer[];
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports?: string;
  createdAt?: string;
  connectionTarget: string;
}

function parseSshToken(rawToken: string, index: number): SshLayer {
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

  let user: string | undefined;
  let password: string | undefined;
  let host = "";
  let port: number | undefined;
  let identityFile: string | undefined;
  let jumpHosts: string[] | undefined;
  let options: string[] | undefined;

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
    ...(user ? { user } : {}),
    ...(port ? { port } : {}),
    ...(password ? { password } : {}),
    ...(identityFile ? { identityFile } : {}),
    ...(jumpHosts && jumpHosts.length > 0 ? { jumpHosts } : {}),
    ...(options && options.length > 0 ? { options } : {}),
  };
}

function parseDockerToken(rawToken: string, index: number): DockerLayer {
  let content = rawToken.trim();
  if (content.startsWith("docker:")) content = content.slice(7);

  let user: string | undefined;
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
    ...(user ? { user } : {}),
  };
}

export function formatRouteLayer(layer: RouteLayer, hidePassword = true): string {
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

export function parseTargetSpec(input: string, options?: { defaultPassword?: string }): ParsedTarget {
  const value = input.trim();
  if (!value) throw new Error("Target is required");
  if (!value.includes("|") && value.includes(":") && !value.startsWith("ssh:") && !value.startsWith("ssh://") && !value.startsWith("docker:")) {
    throw new Error(`Unsupported target layer: ${value}. Use ssh:<host> or docker:<container>`);
  }
  const tokens = value.includes("|") || value.startsWith("ssh:") || value.startsWith("ssh://") || value.startsWith("docker:")
    ? value.split("|").map((token) => token.trim()).filter(Boolean)
    : [`docker:${value}`];
  if (tokens.length === 0) throw new Error("Target route is empty");

  const route: RouteLayer[] = tokens.map((token, index) => {
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
    route,
  };
}

export function parseDockerPs(output: string, prefix = ""): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
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
      ports: String(value.Ports ?? "") || undefined,
      createdAt: String(value.CreatedAt ?? value.RunningFor ?? "") || undefined,
      connectionTarget: `${prefix}${prefix ? "|" : ""}docker:${id}`,
    });
  }
  return containers;
}

function abortError(signal: AbortSignal): Error {
  return new Error(signal.reason ? String(signal.reason) : "aborted");
}

async function runCaptured(command: string, args: string[], signal?: AbortSignal, timeoutMs = 15_000): Promise<string> {
  if (signal?.aborted) throw abortError(signal);
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let interrupted: Error | undefined;
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const stop = (error: Error) => {
      interrupted = error;
      child.kill();
    };
    const abort = () => stop(abortError(signal!));
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

export async function listDockerContainers(prefix?: ParsedTarget, signal?: AbortSignal): Promise<DockerContainer[]> {
  const format = "{{json .}}";
  if (!prefix) {
    const output = await runCaptured("docker", ["ps", "--no-trunc", "--format", format], signal);
    return parseDockerPs(output);
  }
  const profile: RouteSpec = { route: prefix.route, cwd: "/" };
  const launch = compileRoute(profile, `docker ps --no-trunc --format '${format}'`);
  const output = await runCaptured(launch.command, launch.args, signal);
  return parseDockerPs(output, prefix.normalized);
}

export async function resolveDockerIdentity(parsed: ParsedTarget, signal?: AbortSignal): Promise<ParsedTarget> {
  const resolved: RouteLayer[] = [];
  for (const layer of parsed.route) {
    if (layer.type === "ssh") {
      resolved.push(layer);
      continue;
    }
    const prefix: ParsedTarget | undefined = resolved.length > 0
      ? {
          route: [...resolved],
          normalized: resolved.map((item) => item.type === "ssh" ? `ssh:${item.host}` : `docker:${item.container}`).join("|"),
        }
      : undefined;
    const containers = await listDockerContainers(prefix, signal);
    const matches = containers.filter((container) =>
      container.name === layer.container || container.id === layer.container || container.id.startsWith(layer.container),
    );
    if (matches.length === 0) throw new Error(`Running Docker container not found: ${layer.container}`);
    if (matches.length > 1) throw new Error(`Docker container reference is ambiguous: ${layer.container}`);
    resolved.push({ ...layer, container: matches[0]!.id });
  }
  return {
    route: resolved,
    normalized: resolved.map((layer) => layer.type === "ssh" ? `ssh:${layer.host}` : `docker:${layer.container}`).join("|"),
  };
}
