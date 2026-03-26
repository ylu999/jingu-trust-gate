import path from "node:path";
import { loadTask } from "../src/loader/load-task.js";
import { runTask } from "../src/runtime/run-task.js";

async function main(): Promise<void> {
  const taskFile = process.argv[2];
  if (!taskFile) {
    console.error("Usage: node dist/cli/run.js <task.json>");
    process.exit(1);
  }

  const task = loadTask(taskFile);
  const taskDir = path.dirname(path.resolve(taskFile));
  const workspaceDir = path.join(taskDir, "repo");

  console.log(`Task: ${task.goal}`);
  console.log(`Workspace: ${workspaceDir}`);

  await runTask(task, {
    workspaceDir,
    evidenceDir: path.join(process.cwd(), ".jingu"),
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
