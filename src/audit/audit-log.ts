import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry, AuditWriter } from "../types/audit.js";

export class FileAuditWriter implements AuditWriter {
  constructor(private readonly filePath: string) {}

  async append(entry: AuditEntry): Promise<void> {
    // Ensure directory exists
    await mkdir(dirname(this.filePath), { recursive: true });
    // Append one JSON line (newline-delimited JSON)
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.filePath, line, "utf-8");
  }
}

// Default path: .jingu-harness/audit.jsonl relative to cwd
export function createDefaultAuditWriter(): FileAuditWriter {
  return new FileAuditWriter(".jingu-harness/audit.jsonl");
}
