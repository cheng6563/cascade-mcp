# cascade-mcp

Zero-configuration dynamic **SSH** and **Docker** remote development Model Context Protocol (MCP) server with streaming transfer and process control.

Ported from the Pi Cascade extension into a standalone, universal MCP server.

## Key Features

- **Zero Setup Remote Operations**: Connect to local/remote Docker containers, SSH servers, and nested multi-layer chains (e.g. `ssh:jump-host|docker:my-container`) without installing Python, Node.js, or daemons on target hosts.
- **Self-contained Go Helper**: Automatically probes remote Linux architecture (`amd64` / `arm64`) and injects a standalone statically linked helper with `pidfd`/`procfs` child process control.
- **Full Remote Toolset**: Read, write, edit, bash execution, directory listing, glob finding, text grepping, and bidirectional streaming file copy.
- **Adaptive Compression**: Fast file copy with automatic zstd compression and streaming backpressure.
- **Universal MCP Compatibility**: Seamlessly integrates with Codex, Claude Desktop, Cursor, Zed, and any MCP-compliant AI assistant via standard I/O (stdio).

## Quick Start

You can run the server directly from GitHub without manual cloning or building:

```bash
npx -y github:cheng6563/cascade-mcp
```

### MCP Client Configuration

#### Codex / Claude Desktop (`mcpServers` config)

Add to your MCP configuration file (e.g. `~/.codex/config.toml` or Claude desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cascade": {
      "command": "npx",
      "args": ["-y", "github:cheng6563/cascade-mcp"]
    }
  }
}
```

Or for Codex `config.toml`:

```toml
[mcp_servers.cascade]
command = "npx"
args = ["-y", "github:cheng6563/cascade-mcp"]
```

## Available Tools

| Tool | Description |
| --- | --- |
| `cascade_target` | Discover, open, close, and manage target connections (`action: "list" \| "open" \| "close" \| "handles" \| "status" \| "forget" \| "disconnect"`). |
| `cascade_remote_bash` | Execute shell commands in target environments with stdout/stderr capture and cancellation. |
| `cascade_remote_read` | Read remote files with offset and line limits. |
| `cascade_remote_write` | Write content to remote files (auto-creates parent directories). |
| `cascade_remote_edit` | Apply exact, unambiguous search-and-replace text edits. |
| `cascade_remote_ls` | List directory contents with file sizes and directory indicators. |
| `cascade_remote_find` | Search files on the remote filesystem by glob pattern. |
| `cascade_remote_grep` | Search text patterns within files on the target. |
| `cascade_remote_copy` | Bidirectional streaming file upload and download with zstd compression. |

## License

MIT License
