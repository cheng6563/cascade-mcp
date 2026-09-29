import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface SshLayer {
    type: "ssh";
    host: string;
    user?: string;
    port?: number;
    password?: string;
    identityFile?: string;
    jumpHosts?: string[];
    options?: string[];
}
interface DockerLayer {
    type: "docker";
    container: string;
    user?: string;
}
type RouteLayer = SshLayer | DockerLayer;
interface RouteSpec {
    route: RouteLayer[];
    cwd: string;
    connectTimeoutSeconds?: number;
}
type TargetProfile = RouteSpec;
type CopyCompression = "auto" | "none" | "zstd";
type SelectedCopyCompression = Exclude<CopyCompression, "auto">;
type BridgeRequest = {
    id: string;
    op: "ping";
} | {
    id: string;
    op: "read";
    path: string;
} | {
    id: string;
    op: "mime";
    path: string;
} | {
    id: string;
    op: "write";
    path: string;
    data: string;
} | {
    id: string;
    op: "access";
    path: string;
    mode?: number;
} | {
    id: string;
    op: "mkdir";
    path: string;
} | {
    id: string;
    op: "stat";
    path: string;
} | {
    id: string;
    op: "readdir";
    path: string;
} | {
    id: string;
    op: "glob";
    path: string;
    pattern: string;
    ignore: string[];
    limit: number;
} | {
    id: string;
    op: "grep";
    path: string;
    pattern: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit: number;
} | {
    id: string;
    op: "exec";
    command: string;
    cwd: string;
    env?: Record<string, string>;
} | {
    id: string;
    op: "copy_download";
    path: string;
    compression: CopyCompression;
} | {
    id: string;
    op: "copy_upload";
    path: string;
    compression: SelectedCopyCompression;
    mode: number;
} | {
    id: string;
    op: "copy_chunk";
    data: string;
} | {
    id: string;
    op: "copy_end";
} | {
    id: string;
    op: "cancel";
    target: string;
};
type BridgeRequestInput = BridgeRequest extends infer Request ? Request extends {
    id: string;
} ? Omit<Request, "id"> : never : never;
interface BridgeFrame {
    id: string;
    type: "ready" | "meta" | "data" | "result" | "error";
    stream?: "stdout" | "stderr" | "content";
    data?: string;
    result?: unknown;
    message?: string;
}

declare class CascadeLogger {
    readonly path: string;
    constructor(baseDir?: string);
    write(event: string, fields?: Record<string, unknown>): Promise<void>;
}

declare class CascadeClient {
    readonly profileName: string;
    readonly profile: RouteSpec;
    private readonly logger;
    private child?;
    private pending;
    private sequence;
    private starting?;
    private closePromise?;
    private startupAbort;
    private closing;
    private stderrTail;
    private outputBackpressure;
    remoteHostname?: string;
    constructor(profileName: string, profile: RouteSpec, logger?: CascadeLogger);
    start(signal?: AbortSignal): Promise<void>;
    private runRouteCommand;
    private probeArchitecture;
    private startInternal;
    private handleFrame;
    private failAll;
    private beginRequest;
    request<T>(request: BridgeRequestInput, options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
        onMeta?: (value: unknown) => void;
        onData?: (data: Buffer, stream: "stdout" | "stderr" | "content") => unknown;
    }): Promise<T>;
    upload<T>(request: {
        op: "copy_upload";
        path: string;
        compression: SelectedCopyCompression;
        mode: number;
    }, chunks: AsyncIterable<Buffer>, options?: {
        signal?: AbortSignal;
        onWireChunk?: (bytes: number) => void;
    }): Promise<T>;
    private writeRequest;
    private send;
    close(): Promise<void>;
}

interface LaunchSpec {
    command: string;
    args: string[];
    display: string;
    password?: string;
}
interface CompileRouteOptions {
    compressSsh?: boolean;
}
declare function shellQuote(value: string): string;
declare function compileRoute(profile: RouteSpec, terminalCommand: string, options?: CompileRouteOptions): LaunchSpec;
declare function describeRoute(route: RouteLayer[]): string;

interface ParsedTarget {
    normalized: string;
    route: RouteLayer[];
}
interface DockerContainer {
    id: string;
    name: string;
    image: string;
    status: string;
    ports?: string;
    createdAt?: string;
    connectionTarget: string;
}
declare function formatRouteLayer(layer: RouteLayer, hidePassword?: boolean): string;
declare function parseTargetSpec(input: string, options?: {
    defaultPassword?: string;
}): ParsedTarget;
declare function parseDockerPs(output: string, prefix?: string): DockerContainer[];
declare function listDockerContainers(prefix?: ParsedTarget, signal?: AbortSignal): Promise<DockerContainer[]>;
declare function resolveDockerIdentity(parsed: ParsedTarget, signal?: AbortSignal): Promise<ParsedTarget>;

interface CopyProgress {
    direction: "upload" | "download";
    compression: SelectedCopyCompression;
    logicalBytes: number;
    wireBytes: number;
    totalLogicalBytes: number;
}
interface CopyTransferResult {
    compression: SelectedCopyCompression;
    logicalBytes: number;
    wireBytes: number;
    mode: number;
    ratio: number;
}
declare function selectLocalCopyCompression(localPath: string, size: number, requested: CopyCompression): Promise<SelectedCopyCompression>;
declare function uploadLocalFile(client: CascadeClient, localPath: string, remotePath: string, requestedCompression: CopyCompression, options?: {
    signal?: AbortSignal;
    onProgress?: (progress: CopyProgress) => void;
}): Promise<CopyTransferResult>;
declare function downloadRemoteFile(client: CascadeClient, remotePath: string, localPath: string, requestedCompression: CopyCompression, options?: {
    signal?: AbortSignal;
    onProgress?: (progress: CopyProgress) => void;
}): Promise<CopyTransferResult>;

declare const DEFAULT_MAX_BYTES: number;
declare function formatSize(bytes: number): string;
declare function truncateLine(line: string, maxChars?: number): {
    text: string;
    wasTruncated: boolean;
};
declare function truncateHead(content: string, options?: {
    maxLines?: number;
    maxBytes?: number;
}): {
    content: string;
    truncated: boolean;
};
declare function inside(root: string, value: string): boolean;
declare function createPathMapper(localCwd: string, remoteCwd: string, remoteHome?: string): (value: string) => string;
interface FindToolInput {
    pattern: string;
    path?: string;
    limit?: number;
}
interface FindToolDetails {
    resultLimitReached?: number;
    truncation?: {
        content: string;
        truncated: boolean;
    };
}
interface GrepToolInput {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
}
interface GrepToolDetails {
    matchLimitReached?: number;
    linesTruncated?: boolean;
    truncation?: {
        content: string;
        truncated: boolean;
    };
}
interface StatResponse {
    isDirectory: boolean;
    size: number;
}
declare function createRemoteOperations(client: CascadeClient, localCwd: string, remoteCwd: string, remoteHome?: string, signal?: AbortSignal): {
    read: {
        readFile(filePath: string): Promise<Buffer>;
        access(filePath: string): Promise<void>;
        detectImageMimeType(filePath: string): Promise<string | null>;
    };
    write: {
        writeFile(filePath: string, content: string | Buffer): Promise<void>;
        mkdir(dirPath: string): Promise<void>;
    };
    ls: {
        exists(filePath: string): Promise<boolean>;
        stat(filePath: string): Promise<StatResponse>;
        readdir(dirPath: string): Promise<string[]>;
    };
    bash: {
        exec(command: string, cwd: string, options: {
            timeout?: number;
            env?: Record<string, string>;
            signal?: AbortSignal;
            onData?: (data: Buffer, stream: "stdout" | "stderr" | "content") => unknown;
        }): Promise<{
            exitCode: number;
        }>;
    };
    remote: (value: string) => string;
};
declare function executeRemoteFind(client: CascadeClient, toRemote: (value: string) => string, localCwd: string, params: FindToolInput, signal?: AbortSignal): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: FindToolDetails | undefined;
}>;
declare function executeRemoteGrep(client: CascadeClient, toRemote: (value: string) => string, localCwd: string, params: GrepToolInput, signal?: AbortSignal): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: GrepToolDetails | undefined;
}>;

type HandleMode = "transient" | "pinned";
type HandleState = "ready" | "closing";
type ProcessControlMode = "pidfd" | "procfs-fallback";
interface PersistedTarget {
    kind: "target";
    target: string;
    displayTarget?: string;
    cwd?: string;
}
interface RuntimeHandle {
    id: string;
    sequenceNumber: number;
    aliases: string[];
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
interface OpenTargetOptions {
    cwd?: string;
    mode?: HandleMode;
    password?: string;
    signal?: AbortSignal;
    persist?: boolean;
}
declare function slugifyName(val: string): string;
declare function determineBaseHandleName(route: RouteLayer[], remoteHostname?: string): string;
declare function generateUniqueHandleId(base: string, existingHandles: Map<string, RuntimeHandle>): string;
declare class CascadeManager {
    private handles;
    private openingClients;
    private rememberedPinned;
    private handleSequence;
    private stateFilePath;
    private disconnecting;
    private shuttingDown;
    constructor();
    private loadState;
    private saveState;
    private connectionKey;
    private remember;
    forget(targetString: string): boolean;
    getRemembered(): PersistedTarget[];
    getHandles(): RuntimeHandle[];
    getHandle(query: string): RuntimeHandle | undefined;
    acquireHandle(idOrAlias: string): {
        handle: RuntimeHandle;
        release: () => void;
    };
    withHandle<T>(idOrAlias: string, action: (handle: RuntimeHandle) => Promise<T>): Promise<T>;
    private waitForDrain;
    openTarget(target: string, options?: OpenTargetOptions): Promise<RuntimeHandle>;
    closeHandle(idOrAlias: string): Promise<void>;
    closeAll(): Promise<void>;
}

declare function resolveRemotePath(inputPath: string, remoteCwd: string): string;
interface ToolResult {
    [x: string]: unknown;
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
}
declare function handleTargetAction(manager: CascadeManager, params: {
    action: "list" | "open" | "handles" | "status" | "close" | "forget" | "disconnect";
    target?: string;
    password?: string;
    host?: string;
    cwd?: string;
    handle?: string;
    mode?: "transient" | "pinned";
}, signal?: AbortSignal): Promise<ToolResult>;
declare function handleRemoteRead(manager: CascadeManager, params: {
    handle: string;
    path: string;
    offset?: number;
    limit?: number;
}, signal?: AbortSignal): Promise<ToolResult>;
declare function handleRemoteWrite(manager: CascadeManager, params: {
    handle: string;
    path: string;
    content: string;
}, signal?: AbortSignal): Promise<ToolResult>;
declare function handleRemoteEdit(manager: CascadeManager, params: {
    handle: string;
    path: string;
    edits: Array<{
        oldText: string;
        newText: string;
    }>;
}, signal?: AbortSignal): Promise<ToolResult>;
declare function handleRemoteBash(manager: CascadeManager, params: {
    handle: string;
    command: string;
    timeout?: number;
}, signal?: AbortSignal): Promise<ToolResult>;
declare function handleRemoteLs(manager: CascadeManager, params: {
    handle: string;
    path?: string;
    limit?: number;
}, signal?: AbortSignal): Promise<ToolResult>;
declare function handleRemoteFind(manager: CascadeManager, params: {
    handle: string;
    pattern: string;
    path?: string;
    limit?: number;
}, signal?: AbortSignal): Promise<ToolResult>;
declare function handleRemoteGrep(manager: CascadeManager, params: {
    handle: string;
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
}, signal?: AbortSignal): Promise<ToolResult>;
declare function handleRemoteCopy(manager: CascadeManager, params: {
    handle: string;
    direction: "upload" | "download";
    localPath: string;
    remotePath: string;
    compression?: CopyCompression;
}, signal?: AbortSignal): Promise<ToolResult>;

declare function createCascadeMcpServer(manager?: CascadeManager): McpServer;

export { type BridgeFrame, type BridgeRequest, type BridgeRequestInput, CascadeClient, CascadeManager, type CompileRouteOptions, type CopyCompression, type CopyProgress, type CopyTransferResult, DEFAULT_MAX_BYTES, type DockerContainer, type DockerLayer, type FindToolDetails, type FindToolInput, type GrepToolDetails, type GrepToolInput, type HandleMode, type HandleState, type LaunchSpec, type OpenTargetOptions, type ParsedTarget, type PersistedTarget, type ProcessControlMode, type RouteLayer, type RouteSpec, type RuntimeHandle, type SelectedCopyCompression, type SshLayer, type TargetProfile, type ToolResult, compileRoute, createCascadeMcpServer, createPathMapper, createRemoteOperations, describeRoute, determineBaseHandleName, downloadRemoteFile, executeRemoteFind, executeRemoteGrep, formatRouteLayer, formatSize, generateUniqueHandleId, handleRemoteBash, handleRemoteCopy, handleRemoteEdit, handleRemoteFind, handleRemoteGrep, handleRemoteLs, handleRemoteRead, handleRemoteWrite, handleTargetAction, inside, listDockerContainers, parseDockerPs, parseTargetSpec, resolveDockerIdentity, resolveRemotePath, selectLocalCopyCompression, shellQuote, slugifyName, truncateHead, truncateLine, uploadLocalFile };
