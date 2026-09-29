export interface SshLayer {
  type: "ssh";
  host: string;
  user?: string;
  port?: number;
  password?: string;
  identityFile?: string;
  jumpHosts?: string[];
  options?: string[];
}

export interface DockerLayer {
  type: "docker";
  container: string;
  user?: string;
}

export type RouteLayer = SshLayer | DockerLayer;

export interface RouteSpec {
  route: RouteLayer[];
  cwd: string;
  connectTimeoutSeconds?: number;
}

export type TargetProfile = RouteSpec;
export type CopyCompression = "auto" | "none" | "zstd";
export type SelectedCopyCompression = Exclude<CopyCompression, "auto">;

export type BridgeRequest =
  | { id: string; op: "ping" }
  | { id: string; op: "read"; path: string }
  | { id: string; op: "mime"; path: string }
  | { id: string; op: "write"; path: string; data: string }
  | { id: string; op: "access"; path: string; mode?: number }
  | { id: string; op: "mkdir"; path: string }
  | { id: string; op: "stat"; path: string }
  | { id: string; op: "readdir"; path: string }
  | { id: string; op: "glob"; path: string; pattern: string; ignore: string[]; limit: number }
  | { id: string; op: "grep"; path: string; pattern: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit: number }
  | { id: string; op: "exec"; command: string; cwd: string; env?: Record<string, string> }
  | { id: string; op: "copy_download"; path: string; compression: CopyCompression }
  | { id: string; op: "copy_upload"; path: string; compression: SelectedCopyCompression; mode: number }
  | { id: string; op: "copy_chunk"; data: string }
  | { id: string; op: "copy_end" }
  | { id: string; op: "cancel"; target: string };

export type BridgeRequestInput = BridgeRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

export interface BridgeFrame {
  id: string;
  type: "ready" | "meta" | "data" | "result" | "error";
  stream?: "stdout" | "stderr" | "content";
  data?: string;
  result?: unknown;
  message?: string;
}
