import type { DockerLayer, RouteLayer, RouteSpec, SshLayer } from "./types.js";

export interface LaunchSpec {
  command: string;
  args: string[];
  display: string;
  password?: string;
}

export interface CompileRouteOptions {
  compressSsh?: boolean;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function sshTargetString(layer: SshLayer): string {
  if (layer.user && !layer.host.includes("@")) {
    return `${layer.user}@${layer.host}`;
  }
  return layer.host;
}

function jumpHopString(layer: SshLayer): string {
  let hop = "";
  if (layer.user && !layer.host.includes("@")) hop += `${layer.user}@`;
  hop += layer.host;
  if (layer.port) hop += `:${layer.port}`;
  return hop;
}

function sshOptions(layer: SshLayer, connectTimeoutSeconds: number, includeJumpHosts = true, compress = false): string[] {
  const args = [
    "-T",
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
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

function dockerArgs(layer: DockerLayer, command: string): string[] {
  const args = ["exec", "-i"];
  if (layer.user) args.push("-u", layer.user);
  args.push(layer.container, "/bin/sh", "-lc", command);
  return args;
}

function nestedCommand(layer: RouteLayer, command: string, connectTimeoutSeconds: number, compressSsh: boolean): string {
  if (layer.type === "docker") return ["docker", ...dockerArgs(layer, command).map(shellQuote)].join(" ");
  const options = sshOptions(layer, connectTimeoutSeconds, true, compressSsh).map(shellQuote);
  return ["ssh", ...options, shellQuote(sshTargetString(layer)), shellQuote(command)].join(" ");
}

function canFlattenAsJump(layer: SshLayer): boolean {
  return layer.identityFile === undefined
    && layer.password === undefined
    && (layer.options?.length ?? 0) === 0
    && (layer.jumpHosts?.length ?? 0) === 0;
}

export function compileRoute(profile: RouteSpec, terminalCommand: string, options: CompileRouteOptions = {}): LaunchSpec {
  const timeout = profile.connectTimeoutSeconds ?? 10;
  const compressSsh = options.compressSsh ?? false;
  let leadingSshCount = 0;
  while (leadingSshCount < profile.route.length && profile.route[leadingSshCount]?.type === "ssh") leadingSshCount++;

  if (leadingSshCount > 0) {
    const leading = profile.route.slice(0, leadingSshCount) as SshLayer[];
    const target = leading[leading.length - 1]!;
    const flattenStart = leading.slice(0, -1).every(canFlattenAsJump);
    if (flattenStart) {
      let command = terminalCommand;
      for (let index = profile.route.length - 1; index >= leadingSshCount; index--) {
        command = nestedCommand(profile.route[index]!, command, timeout, compressSsh);
      }
      const jumps = [...leading.slice(0, -1).map(jumpHopString), ...(target.jumpHosts ?? [])];
      const args = sshOptions(target, timeout, false, compressSsh);
      if (jumps.length > 0) args.push("-J", jumps.join(","));
      const targetStr = sshTargetString(target);
      args.push(targetStr, command);
      return {
        command: "ssh",
        args,
        display: [...jumps, targetStr].join(" → ssh:"),
        password: target.password,
      };
    }
  }

  const first = profile.route[0]!;
  let command = terminalCommand;
  for (let index = profile.route.length - 1; index >= 1; index--) {
    command = nestedCommand(profile.route[index]!, command, timeout, compressSsh);
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
    password: first.password,
  };
}

export function describeRoute(route: RouteLayer[]): string {
  return route.map((layer) => {
    if (layer.type === "ssh") {
      let s = "ssh:";
      if (layer.user && !layer.host.includes("@")) s += `${layer.user}@`;
      s += layer.host;
      if (layer.port) s += `:${layer.port}`;
      return s;
    }
    return `docker:${layer.container}${layer.user ? `?user=${layer.user}` : ""}`;
  }).join(" → ");
}
