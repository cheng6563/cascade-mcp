#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CascadeManager } from "./manager.js";
import { createCascadeMcpServer } from "./server.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write("Cascade MCP Server - Zero-config dynamic SSH and Docker remote access\n");
    process.stderr.write("Usage: npx -y github:cheng6563/cascade-mcp\n");
    process.stderr.write("This is an MCP server communicating over standard I/O (stdio).\n");
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stderr.write("0.1.0\n");
    process.exit(0);
  }

  const manager = new CascadeManager();
  const server = createCascadeMcpServer(manager);
  const transport = new StdioServerTransport();

  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    try {
      await manager.closeAll();
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Cascade MCP server fatal error: ${err?.stack || err}\n`);
  process.exit(1);
});
