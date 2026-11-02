import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CascadeLogger } from "./logger.js";
import { compileCifsForward } from "./route.js";
import type { RuntimeHandle } from "./manager.js";

interface ActiveMount {
  localPath: string; // 本机目录
  remotePath: string; // 远端挂载点
  share: string; // 临时共享名
  localUser?: string; // 临时本机账户，卸载时删除
  stopTunnel: () => Promise<void>;
}

const logger = new CascadeLogger();
const mountsByHandle = new Map<string, ActiveMount[]>();

/** 挂载本机目录。失败时不留下共享和转发。 */
export async function mountLocalDirectory(
  handle: RuntimeHandle,
  localPath: string,
  remotePath: string,
  password?: string,
): Promise<string> {
  const existing = mountsByHandle.get(handle.id) ?? [];
  if (existing.some((item) => item.remotePath === remotePath)) {
    throw new Error(`已经挂载在 ${remotePath}`);
  }
  compileCifsForward(handle.client.profile);
  const login = await smbLogin(password);
  await logger.write("cifs_mount", {
    message: `开始挂载 ${localPath} 到 ${remotePath}`,
    handle: handle.id,
    localPath,
    remotePath,
    username: login.username,
    domain: login.domain,
    password: login.password,
    localUser: login.localUser,
  });
  let share: string | undefined;
  let stopTunnel: (() => Promise<void>) | undefined;
  let mounted = false;
  try {
    share = await createShare(localPath, login.account, login.localUser ? { name: login.localUser, password: login.password } : undefined);
    await logger.write("cifs_share", { message: `已创建临时共享 ${share}`, handle: handle.id, share, localPath, localUser: login.localUser });
    const tunnel = await handle.client.openCifsTunnel();
    stopTunnel = tunnel.stop;
    void tunnel.exited.then(() => {
      void logger.write("cifs_tunnel_lost", { message: `转发断开，清理共享 ${share}`, handle: handle.id, share, localUser: login.localUser });
      void removeShare(share!, login.localUser).catch(() => undefined);
      const list = (mountsByHandle.get(handle.id) ?? []).filter((item) => item.share !== share);
      if (list.length === 0) mountsByHandle.delete(handle.id);
      else mountsByHandle.set(handle.id, list);
    });
    hookProcessStop();
    await logger.write("cifs_forward", { message: `转发端口 ${tunnel.port}`, handle: handle.id, port: tunnel.port });
    await handle.client.request({
      op: "cifs_mount",
      path: remotePath,
      share,
      port: tunnel.port,
      username: login.username,
      domain: login.domain,
      password: login.password,
    }, { timeoutMs: 30_000 });
    mounted = true;
    const record: ActiveMount = { localPath, remotePath, share, localUser: login.localUser, stopTunnel };
    const current = mountsByHandle.get(handle.id) ?? [];
    mountsByHandle.set(handle.id, [...current, record]);
    await logger.write("cifs_mount_done", { message: `已挂载 ${remotePath}`, handle: handle.id, remotePath, share });
    return remotePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.write("cifs_mount_fail", { message: `挂载失败: ${message}`, handle: handle.id, localPath, remotePath, share, password: login.password });
    if (mounted) {
      await handle.client.request({ op: "cifs_umount", path: remotePath }, { timeoutMs: 20_000 }).catch(() => undefined);
    }
    if (stopTunnel) await stopTunnel().catch(() => undefined);
    if (share) await removeShare(share, login.localUser).catch(() => undefined);
    throw error;
  }
}

/** 当前 handle 上的远端挂载点。 */
export function mountedRemotePaths(handle: RuntimeHandle): string[] {
  return (mountsByHandle.get(handle.id) ?? []).map((item) => item.remotePath);
}

/** 卸掉一个挂载点，并删掉对应的转发和共享。 */
export async function unmountLocalDirectory(handle: RuntimeHandle, remotePath: string): Promise<void> {
  const list = mountsByHandle.get(handle.id) ?? [];
  const item = list.find((entry) => entry.remotePath === remotePath);
  if (!item) throw new Error(`没有挂载 ${remotePath}`);
  await releaseMount(handle, item);
}

/** 关闭 handle 前卸掉它上面的全部分享。出错也继续清后面的。 */
export async function unmountAll(handle: RuntimeHandle): Promise<void> {
  const list = [...(mountsByHandle.get(handle.id) ?? [])];
  const errors: string[] = [];
  for (const item of list) {
    try {
      await releaseMount(handle, item);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

/** 分离挂载、结束转发、删除共享。 */
async function releaseMount(handle: RuntimeHandle, item: ActiveMount): Promise<void> {
  await logger.write("cifs_unmount", { message: `开始卸载 ${item.remotePath}`, handle: handle.id, remotePath: item.remotePath, share: item.share });
  const errors: string[] = [];
  try {
    await handle.client.request({ op: "cifs_umount", path: item.remotePath }, { timeoutMs: 20_000 });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    await item.stopTunnel();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    await removeShare(item.share, item.localUser);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const list = (mountsByHandle.get(handle.id) ?? []).filter((entry) => entry !== item);
  if (list.length === 0) mountsByHandle.delete(handle.id);
  else mountsByHandle.set(handle.id, list);
  if (errors.length > 0) {
    const message = errors.join("\n");
    await logger.write("cifs_unmount_fail", { message: `卸载未完成: ${message}`, handle: handle.id, remotePath: item.remotePath, share: item.share });
    throw new Error(message);
  }
  await logger.write("cifs_unmount_done", { message: `已卸载 ${item.remotePath}`, handle: handle.id, remotePath: item.remotePath, share: item.share });
}

interface SmbAdmin {
  request(op: "share" | "unshare", fields: { name: string; path?: string; account?: string; localUser?: string; localPassword?: string }): Promise<void>;
  onClose(callback: () => void): void;
}

let smbAdmin: SmbAdmin | undefined;
let smbAdminStarting: Promise<SmbAdmin> | undefined;

/** 读取当前 Windows 账户。用提权前的身份，避免 UAC 换成别的管理员。 */
async function windowsAccount(): Promise<{ full: string; domain: string; username: string }> {
  const full = (await readProcess(["whoami.exe"])).trim();
  const slash = full.indexOf("\\");
  if (slash < 0) return { full, domain: "", username: full };
  return { full, domain: full.slice(0, slash), username: full.slice(slash + 1) };
}

/** 没有传入 Windows 密码时，生成临时本机账户。 */
async function smbLogin(password?: string): Promise<{ username: string; domain: string; password: string; account: string; localUser?: string }> {
  if (password) {
    const account = await windowsAccount();
    return { username: account.username, domain: account.domain, password, account: account.full };
  }
  const localUser = `c${randomBytes(4).toString("hex")}`;
  return {
    username: localUser,
    domain: process.env.COMPUTERNAME ?? "",
    password: randomSmbPassword(),
    account: "",
    localUser,
  };
}

/** 生成满足常见复杂度要求的 SMB 密码。 */
function randomSmbPassword(): string {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%";
  const all = lower + upper + digits + symbols;
  const pick = (set: string) => set[randomBytes(1)[0]! % set.length]!;
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  while (chars.length < 20) chars.push(pick(all));
  return chars.join("");
}

/** 创建重启后自动消失的临时共享。传入 localUser 时同时建立临时本机账户。 */
export async function createShare(localPath: string, account: string, localUser?: { name: string; password: string }): Promise<string> {
  const share = `_c${randomBytes(4).toString("hex")}`;
  const admin = await ensureSmbAdmin();
  await admin.request("share", { name: share, path: localPath, account, localUser: localUser?.name, localPassword: localUser?.password });
  rememberLeftover({ share, localUser: localUser?.name });
  return share;
}

/** 删除临时共享。有临时账户时一并删除。 */
export async function removeShare(share: string, localUser?: string): Promise<void> {
  const admin = await ensureSmbAdmin();
  await admin.request("unshare", { name: share, localUser });
  forgetLeftover(share);
  await logger.write("cifs_share_removed", { message: `已删除共享 ${share}`, share, localUser });
}

interface LeftoverShare {
  share: string; // 临时共享名
  localUser?: string; // 临时本机账户
}

let processStopHooked = false;

/** 进程被打断时卸掉本机这边的共享和账户。远端由服务器上的监视进程卸载。 */
function hookProcessStop(): void {
  if (processStopHooked) return;
  processStopHooked = true;
  const stop = () => {
    void cleanupMountedShares().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}

/** 关掉转发并删除还记着的共享和临时账户。 */
async function cleanupMountedShares(): Promise<void> {
  const items = [...mountsByHandle.values()].flat();
  mountsByHandle.clear();
  for (const item of items) {
    await item.stopTunnel().catch(() => undefined);
    await removeShare(item.share, item.localUser).catch(() => undefined);
  }
}

function leftoverFile(): string {
  return join(process.env.TEMP || tmpdir(), "cascade-mcp", "smb-leftovers.json");
}

function readLeftovers(): LeftoverShare[] {
  try {
    const parsed = JSON.parse(readFileSync(leftoverFile(), "utf8")) as LeftoverShare[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLeftovers(items: LeftoverShare[]): void {
  const file = leftoverFile();
  mkdirSync(join(file, ".."), { recursive: true });
  writeLeftoversFile(file, items);
}

function writeLeftoversFile(file: string, items: LeftoverShare[]): void {
  writeFileSync(file, JSON.stringify(items), "utf8");
}

/** 记下还没删掉的共享，进程被强关后下次挂载再清。 */
function rememberLeftover(item: LeftoverShare): void {
  const items = readLeftovers().filter((entry) => entry.share !== item.share);
  items.push(item);
  writeLeftovers(items);
}

function forgetLeftover(share: string): void {
  writeLeftovers(readLeftovers().filter((entry) => entry.share !== share));
}

/** 清掉上次异常退出留下的共享和临时账户。 */
async function sweepLeftovers(admin: SmbAdmin): Promise<void> {
  const items = readLeftovers();
  if (items.length === 0) return;
  const remain: LeftoverShare[] = [];
  for (const item of items) {
    try {
      await admin.request("unshare", { name: item.share, localUser: item.localUser });
      await logger.write("cifs_sweep", { message: `已清理上次留下的共享 ${item.share}`, share: item.share, localUser: item.localUser });
    } catch {
      remain.push(item);
    }
  }
  writeLeftovers(remain);
}

/** 拿到能执行 New-SmbShare 的进程。未提权时弹出一次系统 UAC。 */
async function ensureSmbAdmin(): Promise<SmbAdmin> {
  if (process.platform !== "win32") throw new Error("创建 SMB 共享只支持 Windows");
  if (smbAdmin) return smbAdmin;
  if (!smbAdminStarting) {
    smbAdminStarting = openSmbAdmin().finally(() => { smbAdminStarting = undefined; });
  }
  smbAdmin = await smbAdminStarting;
  return smbAdmin;
}

/** 启动共享管理进程。已是管理员则直接启动，否则用 RunAs 提权。 */
async function openSmbAdmin(): Promise<SmbAdmin> {
  const elevated = (await readProcess(["whoami.exe", "/groups"])).includes("S-1-16-12288");
  const token = randomBytes(16).toString("hex");
  const dir = join(process.env.TEMP || tmpdir(), "cascade-mcp");
  mkdirSync(dir, { recursive: true });
  const workerPath = join(dir, "smb-worker.ps1");
  const launcherPath = join(dir, "smb-launch.ps1");
  writeFileSync(workerPath, `﻿${workerPs1}`, "utf8");
  writeFileSync(launcherPath, `﻿${launcherPs1}`, "utf8");
  await logger.write("cifs_elevate", {
    message: elevated ? "当前进程已是管理员，直接创建共享" : "当前进程未提权，等待 UAC 同意",
  });
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("提权监听端口失败");
  const args = ["-NoProfile", "-NonInteractive", "-File", elevated ? workerPath : launcherPath];
  if (elevated) args.push("-Port", String(address.port), "-Token", token);
  else args.push("-Worker", workerPath, "-Port", String(address.port), "-Token", token);
  const child = spawn("powershell.exe", args, { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  try {
    const admin = await waitForAdmin(server, child, token, () => stderr);
    admin.onClose(() => { if (smbAdmin === admin) smbAdmin = undefined; });
    await sweepLeftovers(admin);
    await logger.write("cifs_elevate_done", { message: "共享提权已就绪" });
    return admin;
  } catch (error) {
    server.close();
    killProcess(child);
    const message = error instanceof Error ? error.message : String(error);
    await logger.write("cifs_elevate_fail", { message: `提权失败: ${message}` });
    throw error;
  }
}

/** 等高完整性进程连上并出示令牌。 */
function waitForAdmin(server: net.Server, child: ChildProcess, token: string, stderr: () => string): Promise<SmbAdmin> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("提权超时，没有等到管理员同意"))), 120_000);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      const detail = stderr().trim();
      reject(new Error(detail || `提权进程退出 code=${code}`));
    }));
    server.on("connection", (socket) => {
      bindAdminSocket(socket, token).then(
        (admin) => finish(() => { server.close(); resolve(admin); }),
        (error) => finish(() => reject(error)),
      );
    });
  });
}

/** 校验令牌，之后只接受创建共享和删除共享。 */
function bindAdminSocket(socket: net.Socket, token: string): Promise<SmbAdmin> {
  socket.setEncoding("utf8");
  let buffer = "";
  let authed = false;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let onClose = () => {};
  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    onClose();
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("提权进程没有完成校验")), 10_000);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!authed) {
          clearTimeout(timer);
          if (line !== token) {
            socket.destroy();
            reject(new Error("提权进程校验失败"));
            return;
          }
          authed = true;
          resolve({
            request(op, fields) {
              const id = nextId++;
              return new Promise<void>((resolveRequest, rejectRequest) => {
                pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
                socket.write(`${JSON.stringify({ id, op, ...fields })}\n`);
              });
            },
            onClose(callback) { onClose = callback; },
          });
          continue;
        }
        const message = JSON.parse(line) as { id: number; ok: boolean; error?: string };
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.ok) waiter.resolve();
        else waiter.reject(new Error(message.error || "共享操作失败"));
      }
    });
    socket.on("error", (error) => failAll(error));
    socket.on("close", () => failAll(new Error("提权进程已断开")));
  });
}

function killProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  child.kill();
}

/** 读取子进程标准输出。 */
function readProcess(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${args[0]} 退出 code=${code}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

const launcherPs1 = `
param([string]$Worker, [string]$Port, [string]$Token)
$ErrorActionPreference = 'Stop'
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $psi.Arguments = "-NoProfile -NonInteractive -File \`"$Worker\`" -Port $Port -Token $Token"
  $psi.UseShellExecute = $true
  $psi.Verb = 'RunAs'
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $process = [System.Diagnostics.Process]::Start($psi)
  $process.WaitForExit()
  exit $process.ExitCode
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`.trim();

const workerPs1 = `
param([int]$Port, [string]$Token)
$ErrorActionPreference = 'Stop'
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('127.0.0.1', $Port)
$stream = $client.GetStream()
$utf8 = New-Object System.Text.UTF8Encoding $false
$writer = New-Object System.IO.StreamWriter($stream, $utf8)
$reader = New-Object System.IO.StreamReader($stream, $utf8)
$writer.AutoFlush = $true
$writer.WriteLine($Token)
while ($null -ne ($line = $reader.ReadLine())) {
  $req = $line | ConvertFrom-Json
  if ($req.op -eq 'exit') { break }
  try {
    if ($req.op -eq 'share') {
      $account = $req.account
      if ($req.localUser) {
        $secure = ConvertTo-SecureString $req.localPassword -AsPlainText -Force
        $created = New-LocalUser -Name $req.localUser -Password $secure -PasswordNeverExpires
        try {
          $grant = "*" + $created.SID.Value + ":(OI)(CI)M"
          & icacls.exe $req.path /grant $grant | Out-Null
          if ($LASTEXITCODE -ne 0) { throw "设置目录权限失败" }
          $account = $created.SID.Translate([System.Security.Principal.NTAccount]).Value
          New-SmbShare -Name $req.name -Path $req.path -Temporary -FullAccess $account | Out-Null
        } catch {
          Remove-LocalUser -Name $req.localUser -ErrorAction SilentlyContinue
          throw
        }
      } else {
        New-SmbShare -Name $req.name -Path $req.path -Temporary -FullAccess $account | Out-Null
      }
    } elseif ($req.op -eq 'unshare') {
      Remove-SmbShare -Name $req.name -Force -ErrorAction SilentlyContinue
      if ($req.localUser) { Remove-LocalUser -Name $req.localUser -ErrorAction SilentlyContinue }
    } else {
      throw "未知操作 $($req.op)"
    }
    $writer.WriteLine((@{ id = $req.id; ok = $true } | ConvertTo-Json -Compress))
  } catch {
    $errorText = ("$_" -replace "[\\r\\n]+", " ")
    $writer.WriteLine((@{ id = $req.id; ok = $false; error = $errorText } | ConvertTo-Json -Compress))
  }
}
$client.Close()
`.trim();
