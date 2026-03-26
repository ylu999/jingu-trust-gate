import fs from "node:fs";
import path from "node:path";
import type { TaskSpec, ExecutionResult } from "../../types.js";
import type { ClaudeAdapterOptions } from "./types.js";

/**
 * Mock agent — writes the corrected src/math.js fix into workspaceDir on first call.
 * Replace with real ClaudeCliExecutor in p146.
 */
export async function runClaudeAgent(
  task: TaskSpec,
  workspaceDir: string,
  _opts: ClaudeAdapterOptions = {},
): Promise<ExecutionResult> {
  console.log(`[mock-agent] task: ${task.goal}`);

  const fixPath = path.join(workspaceDir, "src", "math.js");
  if (fs.existsSync(fixPath)) {
    fs.writeFileSync(fixPath, "export function sum(a, b) { return a + b; }\n", "utf-8");
  }

  return {
    patch: "--- a/src/math.js\n+++ b/src/math.js\n@@ -1 +1 @@\n-export function sum(a, b) { return a - b; }\n+export function sum(a, b) { return a + b; }",
    changedFiles: ["src/math.js"],
    logs: "mock agent applied fix: a - b → a + b",
    exitCode: 0,
  };
}
