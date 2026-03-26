import path from "node:path";
import { loadTask } from "../src/loader/load-task.js";
import { runTask } from "../src/runtime/run-task.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help") {
    console.error("Usage: node dist/cli/run.js <task.json> [--workspace <dir>]");
    process.exit(1);
  }

  const taskFile = args[0];
  if (!taskFile) {
    console.error("Usage: node dist/cli/run.js <task.json> [--workspace <dir>]");
    process.exit(1);
  }

  // Parse optional --workspace flag
  let workspaceFlagDir: string | undefined;
  const wsIdx = args.indexOf("--workspace");
  if (wsIdx !== -1 && args[wsIdx + 1]) {
    workspaceFlagDir = path.resolve(args[wsIdx + 1]!);
  }

  const task = loadTask(taskFile);
  const taskDir = path.dirname(path.resolve(taskFile));
  // Default workspace is <task-dir>/repo; --workspace overrides it.
  const workspaceDir = workspaceFlagDir ?? path.join(taskDir, "repo");

  console.log(`Task: ${task.goal}`);
  console.log(`Workspace: ${workspaceDir}`);

  try {
    await runTask(task, {
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      evidenceDir: path.join(process.cwd(), ".jingu"),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("claude not found in PATH")) {
      console.error(`ERROR: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
