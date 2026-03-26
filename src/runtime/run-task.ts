import os from "node:os";
import type { TaskSpec } from "../types.js";
import type { RunTaskOptions } from "./types.js";
import { runClaudeAgent } from "../adapter/claude/run.js";
import { runVerify } from "../verify/run-verify.js";
import { runInvariants } from "../invariant/run-invariants.js";
import { buildFeedback } from "../adapter/feedback.js";
import { writeEvidence } from "../evidence/write.js";

export async function runTask(
  task: TaskSpec,
  opts: RunTaskOptions,
): Promise<void> {
  const maxRetries = opts.maxRetries ?? task.maxRetries ?? 3;
  // The agent works inside agentWorkspaceDir; verification runs in workspaceDir.
  const agentDir = opts.agentWorkspaceDir ?? opts.workspaceDir ?? os.tmpdir();
  let feedback: string | undefined;

  for (let i = 0; i < maxRetries; i++) {
    console.log(`\n--- Iteration ${i + 1} / ${maxRetries} ---`);

    const result = await runClaudeAgent(task, agentDir, { feedback });

    const invariantFailures = runInvariants(result, task);
    if (invariantFailures.length > 0) {
      const failure = invariantFailures[0]!;
      console.error("Invariant failed:", failure.type);
      feedback = buildFeedback(failure);
      writeEvidence(
        {
          taskId: task.id,
          iteration: i + 1,
          verifyPass: false,
          verifyExitCode: -1,
          decision: "reject",
          changedFiles: result.changedFiles,
          timestamp: Date.now(),
          failureType: failure.type,
        },
        opts.evidenceDir,
      );
      continue;
    }

    const vf = runVerify(task.verify, opts.workspaceDir);

    if (vf !== null) {
      feedback = buildFeedback(vf);
    } else {
      feedback = undefined;
    }

    writeEvidence(
      {
        taskId: task.id,
        iteration: i + 1,
        verifyPass: vf === null,
        verifyExitCode: vf?.exitCode ?? 0,
        decision: vf === null ? "accept" : "retry",
        changedFiles: result.changedFiles,
        timestamp: Date.now(),
        failureType: vf?.type,
      },
      opts.evidenceDir,
    );

    console.log(`verify: ${vf === null ? "PASS" : "FAIL"} (exit ${vf?.exitCode ?? 0})`);
    console.log(`decision: ${vf === null ? "accept" : "retry"}`);

    if (vf === null) {
      console.log("Task accepted.");
      return;
    }
  }

  throw new Error(`Task ${task.id} failed after ${maxRetries} retries`);
}
