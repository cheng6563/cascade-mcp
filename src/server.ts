import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CascadeManager } from "./manager.js";
import {
  handleRemoteBash,
  handleRemoteCopy,
  handleRemoteEdit,
  handleRemoteFind,
  handleRemoteGrep,
  handleRemoteLs,
  handleRemoteRead,
  handleRemoteWrite,
  handleTargetAction,
} from "./tools.js";

export function createCascadeMcpServer(manager = new CascadeManager()): McpServer {
  const server = new McpServer({
    name: "cascade-mcp",
    version: "0.1.0",
  });

  server.tool(
    "cascade_target",
    "Discover, connect, and manage Docker and SSH targets without manual agent setup. " +
      "Use action=list to inspect running Docker containers. " +
      "Use action=open to establish a live connection to a container, SSH host, or nested target chain, returning a target handle. " +
      "Use action=handles or action=status to inspect active connections and remembered targets. " +
      "Use action=close to close a specific handle, or action=disconnect to close all handles. " +
      "Use action=forget to remove a remembered pinned target.",
    {
      action: z.enum(["list", "open", "handles", "status", "close", "forget", "disconnect"]),
      target: z.string().optional(),
      password: z.string().optional(),
      host: z.string().optional(),
      cwd: z.string().optional(),
      handle: z.string().optional(),
      mode: z.enum(["transient", "pinned"]).optional(),
    },
    async (params, extra) => {
      try {
        return await handleTargetAction(manager, params, extra.signal);
      } catch (err: any) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    },
  );

  server.tool(
    "cascade_remote_read",
    "Read a file from an opened remote target. Requires a READY handle returned by cascade_target open. " +
      "Supports offset & limit with line numbers.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      path: z.string().describe("Remote file path"),
      offset: z.number().int().min(1).optional().describe("Starting line number (1-based)"),
      limit: z.number().int().min(1).optional().describe("Number of lines to read"),
    },
    async (params, extra) => {
      try {
        return await handleRemoteRead(manager, params, extra.signal);
      } catch (err: any) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    },
  );

  server.tool(
    "cascade_remote_write",
    "Write content to a file on an opened remote target. Requires a READY handle. Automatically creates parent directories.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      path: z.string().describe("Remote file path"),
      content: z.string().describe("Content to write into the file"),
    },
    async (params, extra) => {
      try {
        return await handleRemoteWrite(manager, params, extra.signal);
      } catch (err: any) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    },
  );

  server.tool(
    "cascade_remote_edit",
    "Apply exact text replacements to a file on an opened remote target. Requires a READY handle. " +
      "Each edit must specify oldText and newText.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      path: z.string().describe("Remote file path"),
      edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1),
    },
    async (params, extra) => {
      try {
        return await handleRemoteEdit(manager, params, extra.signal);
      } catch (err: any) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    },
  );

  server.tool(
    "cascade_remote_bash",
    "Execute a shell command on an opened remote target. Returns stdout, stderr, and exit code. " +
      "Supports execution timeout in seconds. Cancellation cleanly kills child process trees using pidfd/procfs.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      command: z.string().describe("Shell command to run on target"),
      timeout: z.number().positive().optional().describe("Execution timeout in seconds"),
    },
    async (params, extra) => {
      try {
        return await handleRemoteBash(manager, params, extra.signal);
      } catch (err: any) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    },
  );

  server.tool(
    "cascade_remote_ls",
    "List directory entries on an opened remote target. Returns item names, types (DIR/FILE), and sizes.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      path: z.string().optional().describe("Directory path on remote target"),
      limit: z.number().int().min(1).optional().describe("Maximum number of entries to return (default: 500)"),
    },
    async (params, extra) => {
      try {
        return await handleRemoteLs(manager, params, extra.signal);
      } catch (err: any) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    },
  );

  server.tool(
    "cascade_remote_find",
    "Find files matching a glob pattern on an opened remote target. Requires a READY handle.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      pattern: z.string().describe("Glob pattern"),
      path: z.string().optional().describe("Directory to search in"),
      limit: z.number().int().min(1).optional().describe("Maximum results to return"),
    },
    async (params, extra) => {
      try {
        return await handleRemoteFind(manager, params, extra.signal);
      } catch (err: any) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    },
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
      limit: z.number().int().min(1).optional(),
    },
    async (params, extra) => {
      try {
        return await handleRemoteGrep(manager, params, extra.signal);
      } catch (err: any) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    },
  );

  server.tool(
    "cascade_remote_copy",
    "Stream transfer a regular file between local machine and opened remote target. Supports zstd compression.",
    {
      handle: z.string().describe("READY target handle (e.g. target-1)"),
      direction: z.enum(["upload", "download"]).describe("upload: local->remote; download: remote->local"),
      localPath: z.string().describe("Local file path"),
      remotePath: z.string().describe("Remote file path"),
      compression: z.enum(["auto", "none", "zstd"]).optional(),
    },
    async (params, extra) => {
      try {
        return await handleRemoteCopy(manager, params, extra.signal);
      } catch (err: any) {
        return { content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }], isError: true };
      }
    },
  );

  return server;
}
