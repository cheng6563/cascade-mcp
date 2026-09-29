import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CascadeClient } from "./client.js";
import { describeRoute } from "./route.js";
import { parseTargetSpec, resolveDockerIdentity } from "./target.js";
import type { RouteSpec } from "./types.js";

export type HandleMode = "transient" | "pinned";
export type HandleState = "ready" | "closing";
export type ProcessControlMode = "pidfd" | "procfs-fallback";

export interface PersistedTarget {
  kind: "target";
  target: string;
  displayTarget?: string;
  cwd?: string;
}

export interface RuntimeHandle {
  id: string;
  key: string;
  name: string;
  mode: HandleMode;
  state: HandleState;
  client: CascadeClient;
  route: string;
  remoteCwd: string;
  remoteHome: string;
  processControl: ProcessControlMode;
  processControlDetail?: string;
  persisted: PersistedTarget;
  leases: number;
  drainWaiters: Array<() => void>;
  closePromise?: Promise<void>;
}

export interface OpenTargetOptions {
  cwd?: string;
  mode?: HandleMode;
  password?: string;
  signal?: AbortSignal;
  persist?: boolean;
}

export class CascadeManager {
  private handles = new Map<string, RuntimeHandle>();
  private openingClients = new Set<CascadeClient>();
  private rememberedPinned: PersistedTarget[] = [];
  private handleSequence = 0;
  private stateFilePath: string;
  private disconnecting = false;
  private shuttingDown = false;

  constructor() {
    const configDir = path.join(homedir(), ".cascade-mcp");
    if (!existsSync(configDir)) {
      try { mkdirSync(configDir, { recursive: true }); } catch {}
    }
    this.stateFilePath = path.join(configDir, "state.json");
    this.loadState();
  }

  private loadState(): void {
    try {
      if (existsSync(this.stateFilePath)) {
        const raw = readFileSync(this.stateFilePath, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.pinned)) {
          this.rememberedPinned = data.pinned;
        }
      }
    } catch {}
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFilePath, JSON.stringify({ version: 2, pinned: this.rememberedPinned }, null, 2), "utf8");
    } catch {}
  }

  private connectionKey(persisted: PersistedTarget): string {
    return `target:${persisted.target}:${persisted.cwd || ""}`;
  }

  private remember(connection: PersistedTarget): void {
    const key = this.connectionKey(connection);
    if (!this.rememberedPinned.some((item) => this.connectionKey(item) === key)) {
      this.rememberedPinned.push(connection);
      this.saveState();
    }
  }

  public forget(targetString: string): boolean {
    const parsed = parseTargetSpec(targetString);
    const initialLen = this.rememberedPinned.length;
    this.rememberedPinned = this.rememberedPinned.filter(
      (item) => item.target !== parsed.normalized && item.displayTarget !== parsed.normalized,
    );
    const changed = this.rememberedPinned.length !== initialLen;
    if (changed) this.saveState();
    return changed;
  }

  public getRemembered(): PersistedTarget[] {
    return [...this.rememberedPinned];
  }

  public getHandles(): RuntimeHandle[] {
    return [...this.handles.values()];
  }

  public getHandle(id: string): RuntimeHandle | undefined {
    return this.handles.get(id);
  }

  public acquireHandle(id: string): { handle: RuntimeHandle; release: () => void } {
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
      },
    };
  }

  public async withHandle<T>(id: string, action: (handle: RuntimeHandle) => Promise<T>): Promise<T> {
    const lease = this.acquireHandle(id);
    try {
      return await action(lease.handle);
    } finally {
      lease.release();
    }
  }

  private waitForDrain(handle: RuntimeHandle): Promise<void> {
    if (handle.leases === 0) return Promise.resolve();
    return new Promise<void>((resolve) => handle.drainWaiters.push(resolve));
  }

  public async openTarget(target: string, options: OpenTargetOptions = {}): Promise<RuntimeHandle> {
    if (this.shuttingDown) throw new Error("Cascade is shutting down");
    if (this.disconnecting) throw new Error("Cascade is disconnecting");
    const { cwd, mode = "pinned", password, signal, persist = true } = options;
    if (signal?.aborted) throw new Error(signal.reason ? String(signal.reason) : "aborted");

    const requested = parseTargetSpec(target, { defaultPassword: password });
    const resolved = await resolveDockerIdentity(requested, signal);
    const profile: RouteSpec = { route: resolved.route, cwd: cwd || "/" };
    const persisted: PersistedTarget = {
      kind: "target",
      target: resolved.normalized,
      displayTarget: requested.normalized !== resolved.normalized ? requested.normalized : undefined,
      cwd,
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
      const bridge = await client.request<{
        home: string;
        cwd: string;
        processControl?: ProcessControlMode;
        processControlDetail?: string;
      }>({ op: "ping" }, { timeoutMs: 8000, signal });

      const remoteCwd = cwd || bridge.cwd || bridge.home || "/";
      const handle: RuntimeHandle = {
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
        closePromise: undefined,
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

  public async closeHandle(id: string): Promise<void> {
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

  public async closeAll(): Promise<void> {
    this.disconnecting = true;
    try {
      await Promise.allSettled([...this.openingClients].map((c) => c.close()));
      await Promise.allSettled([...this.handles.keys()].map((id) => this.closeHandle(id)));
    } finally {
      this.disconnecting = false;
    }
  }
}
