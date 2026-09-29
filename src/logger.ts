import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export class CascadeLogger {
  readonly path: string;

  constructor(baseDir = process.env.TEMP || process.env.TMP || join(process.cwd(), "temp")) {
    this.path = join(baseDir, "cascade-mcp", "cascade.jsonl");
  }

  async write(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    try {
      await mkdir(join(this.path, ".."), { recursive: true });
      await appendFile(this.path, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`, "utf8");
    } catch {
      // Logging must never break remote operations.
    }
  }
}
