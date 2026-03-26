import os from "node:os";
import type { TaskSpec } from "../types.js";
import type { RunTaskOptions } from "./types.js";
import { runClaudeAgent } from "../adapter/claude/run.js";
import { runVerify } from "../verify/run-verify.js";
import { runInvariants } from "../invariant/run-invariants.js";
import { decide } from "../decision/decide.js";
import { writeEvidence } from "../evidence/write.js";

export async function runTask(
  task: TaskSpec,
  opts: RunTaskOptions,
): Promise<void> {
  const maxRetries = opts.maxRetries ?? task.maxRetries ?? 3;
  // The agent works inside agentWorkspaceDir; verification runs in workspaceDir.
  const agentDir = opts.agentWorkspaceDir ?? opts.workspaceDir ?? os.tmpdir();

  for (let i = 0; i < maxRetries; i++) {
    console.log(`\n--- Iteration ${i + 1} / ${maxRetries} ---`);

    const result = await runClaudeAgent(task, agentDir);

    try {
      runInvariants(result, task);
    } catch (err) {
      console.error("Invariant failed:", (err as Error).message);
      writeEvidence(
        {
          taskId: task.id,
          iteration: i + 1,
          verifyPass: false,
          verifyExitCode: -1,
          decision: "reject",
          changedFiles: result.changedFiles,
          timestamp: Date.now(),
        },
        opts.evidenceDir,
      );
      continue;
    }

    const verify = runVerify(task.verify, opts.workspaceDir);
    const decision = decide(verify);

    writeEvidence(
      {
        taskId: task.id,
        iteration: i + 1,
        verifyPass: verify.pass,
        verifyExitCode: verify.exitCode,
        decision,
        changedFiles: result.changedFiles,
        timestamp: Date.now(),
      },
      opts.evidenceDir,
    );

    console.log(`verify: ${verify.pass ? "PASS" : "FAIL"} (exit ${verify.exitCode})`);
    console.log(`decision: ${decision}`);

    if (decision === "accept") {
      console.log("Task accepted.");
      return;
    }
  }

  throw new Error(`Task ${task.id} failed after ${maxRetries} retries`);
}
