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
  // 首次连接自动信任未知主机指纹（指纹变化仍会拒绝）；用户显式指定时不覆盖
  if (!layer.options?.some((option) => /^\s*StrictHostKeyChecking\s*[= ]/i.test(option))) {
    args.push("-o", "StrictHostKeyChecking=accept-new");
  }
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

function routePassword(layers: SshLayer[]): string | undefined {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (layers[index]?.password) return layers[index]!.password;
  }
  return undefined;
}

function cmdQuote(value: string): string {
  if (value === "") return '""';
  if (/[\s"&|<>^]/.test(value)) return `"${value.replaceAll("\"", "\\\"")}"`;
  return value;
}

function proxyCommand(hops: SshLayer[], timeout: number): string {
  let command = "";
  for (const hop of hops) {
    const bits = ["ssh", ...sshOptions(hop, timeout, true, false).map(cmdQuote)];
    if (command) bits.push("-o", cmdQuote(`ProxyCommand=${command}`));
    bits.push("-W", "%h:%p", cmdQuote(sshTargetString(hop)));
    command = bits.join(" ");
  }
  return command;
}

/** 本机 ssh 作为最终主机的客户端，-R 把该主机的回环端口转到 Windows 的 445。 */
export function compileCifsForward(profile: RouteSpec): LaunchSpec {
  if (profile.route.some((layer) => layer.type === "docker")) {
    throw new Error("挂载不支持含 Docker 的路由");
  }
  const layers = profile.route.filter((layer): layer is SshLayer => layer.type === "ssh");
  const target = layers[layers.length - 1];
  if (!target) throw new Error("挂载需要 SSH 目标");
  const timeout = profile.connectTimeoutSeconds ?? 10;
  const leading = layers.slice(0, -1);
  const forwardArgs = [
    "-n",
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "LogLevel=INFO",
    "-R", "127.0.0.1:0:127.0.0.1:445",
  ];
  if (leading.every(canFlattenAsJump)) {
    const jumps = [...leading.map(jumpHopString), ...(target.jumpHosts ?? [])];
    const args = [...forwardArgs, ...sshOptions(target, timeout, false, false)];
    if (jumps.length > 0) args.push("-J", jumps.join(","));
    args.push(sshTargetString(target));
    return { command: "ssh", args, display: describeRoute(profile.route), password: routePassword(layers) };
  }
  const proxyHops = [...leading];
  for (const hop of target.jumpHosts ?? []) proxyHops.push({ type: "ssh", host: hop });
  const args = [...forwardArgs, ...sshOptions(target, timeout, false, false)];
  const proxy = proxyCommand(proxyHops, timeout);
  if (proxy) args.push("-o", `ProxyCommand=${proxy}`);
  args.push(sshTargetString(target));
  return { command: "ssh", args, display: describeRoute(profile.route), password: routePassword(layers) };
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
