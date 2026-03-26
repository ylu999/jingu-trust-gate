import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import type { TaskSpec, ExecutionResult } from "../../types.js";
import type { ClaudeAdapterOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers (shared by mock and real adapters)
// ---------------------------------------------------------------------------

/**
 * parseGitDiff — splits a unified diff by file.
 * Returns an array of { path, diff } per changed file.
 */
function parseGitDiff(raw: string): Array<{ path: string; diff: string }> {
  const result: Array<{ path: string; diff: string }> = [];
  const chunks = raw.split(/^(?=diff --git )/m).filter(Boolean);
  for (const chunk of chunks) {
    const match = chunk.match(/^\+\+\+ b\/(.+)$/m);
    if (match?.[1]) {
      result.push({ path: match[1], diff: chunk });
    }
  }
  return result;
}

/**
 * ensureGitBaseline — if the workspace has no .git, initialise a baseline
 * commit so that `git diff HEAD` reliably shows what the agent changed.
 */
function ensureGitBaseline(workspacePath: string): void {
  if (fs.existsSync(path.join(workspacePath, ".git"))) return;
  execFileSync("git", ["init"], { cwd: workspacePath });
  execFileSync("git", ["add", "-A"], { cwd: workspacePath });
  execFileSync(
    "git",
    [
      "-c", "user.email=jingu@local",
      "-c", "user.name=jingu",
      "commit", "--allow-empty", "-m", "init",
    ],
    { cwd: workspacePath },
  );
}

// ---------------------------------------------------------------------------
// Real Claude CLI adapter
// ---------------------------------------------------------------------------

/**
 * runClaudeAgentReal — spawns `claude -p <prompt>` as a subprocess.
 *
 * Claude Code runs freely inside workspaceDir: it can Read/Grep/Edit/Bash
 * at will, run the verify command itself, and iterate until satisfied.
 *
 * After the subprocess exits, we extract the patch from `git diff HEAD`.
 */
function runClaudeAgentReal(
  task: TaskSpec,
  workspaceDir: string,
  opts: ClaudeAdapterOptions = {},
): ExecutionResult {
  // Guard: claude must be in PATH
  const whichResult = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (whichResult.status !== 0 || !whichResult.stdout.trim()) {
    throw new Error(
      "claude not found in PATH. Install Claude Code CLI.",
    );
  }

  ensureGitBaseline(workspaceDir);

  const verifyLine =
    task.verify.type === "command"
      ? `Verify command: ${task.verify.command}\n\n`
      : "";

  const prompt =
    `Task: ${task.goal}\n\n` +
    verifyLine +
    `Use tools to explore and fix. Run verify. Do not explain.`;

  const timeoutMs = opts.timeoutMs ?? 180_000;

  const result = spawnSync(
    "claude",
    [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: workspaceDir,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`claude spawn failed: ${result.error.message}`);
  }

  const rawOut = (result.stdout ?? "").trim();
  const logs = rawOut.slice(0, 500) || `claude-cli run for ${task.id}`;

  // Extract changed files + patch from git
  let changedFiles: string[] = [];
  let patch = "";
  try {
    const nameOnly = execFileSync(
      "git",
      ["diff", "--name-only", "HEAD"],
      { cwd: workspaceDir, encoding: "utf8" },
    ).trim();
    changedFiles = nameOnly ? nameOnly.split("\n").filter(Boolean) : [];

    const rawDiff = execFileSync(
      "git",
      ["diff", "-U5", "HEAD"],
      { cwd: workspaceDir, encoding: "utf8" },
    );
    const fileDiffs = parseGitDiff(rawDiff);
    patch = fileDiffs[0]?.diff ?? "";
  } catch {
    // git diff may fail if nothing changed — empty arrays are valid
  }

  return {
    patch,
    changedFiles,
    logs,
    exitCode: result.status ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Mock adapter (default fallback)
// ---------------------------------------------------------------------------

function runClaudeAgentMock(
  task: TaskSpec,
  workspaceDir: string,
): ExecutionResult {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * runClaudeAgent — routes to real or mock adapter.
 *
 * Set JINGU_REAL_AGENT=1 (or opts.real=true) to use the real Claude CLI.
 * Default: mock adapter (always works, no external dependency).
 */
export async function runClaudeAgent(
  task: TaskSpec,
  workspaceDir: string,
  opts: ClaudeAdapterOptions = {},
): Promise<ExecutionResult> {
  const useReal =
    opts.real === true || process.env["JINGU_REAL_AGENT"] === "1";

  if (useReal) {
    return runClaudeAgentReal(task, workspaceDir, opts);
  }

  return runClaudeAgentMock(task, workspaceDir);
}
