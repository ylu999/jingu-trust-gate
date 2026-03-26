import os from "node:os";
import type { TaskSpec } from "../types.js";
import type { RunTaskOptions } from "./types.js";
import { runClaudeAgent } from "../adapter/claude/run.js";
import { runVerify } from "../verify/run-verify.js";
import { runInvariants } from "../invariant/run-invariants.js";
import { parseTestSummary, checkRegression } from "../invariant/regression.js";
import type { TestSummary } from "../invariant/regression.js";
import { mapFailureToStrategy } from "../strategy/map.js";
import type { Strategy } from "../strategy/types.js";
import { writeEvidence } from "../evidence/write.js";
import { persistRun } from "../evidence/persist.js";
import type { Run, Step } from "./state.js";
import type { Failure } from "../failure/types.js";
import type { ExecutionResult } from "../types.js";

function recordStep(
  run: Run,
  result: ExecutionResult,
  failure: Failure | undefined,
  strategy: Strategy | undefined,
  decision: Step["decision"],
): void {
  run.history.push({
    iteration: run.iteration,
    result,
    failure,
    strategy,
    decision,
    timestamp: Date.now(),
  });
}

export async function runTask(
  task: TaskSpec,
  opts: RunTaskOptions,
): Promise<Run> {
  const maxRetries = opts.maxRetries ?? task.maxRetries ?? 3;
  // The agent works inside agentWorkspaceDir; verification runs in workspaceDir.
  const agentDir = opts.agentWorkspaceDir ?? opts.workspaceDir ?? os.tmpdir();
  let strategy: Strategy | undefined;
  let prevTestSummary: TestSummary | null = null;

  const run: Run = {
    id: Date.now().toString(),
    state: "INIT",
    iteration: 0,
    lastFailure: undefined,
    history: [],
  };

  while (true) {
    run.iteration += 1;
    run.state = run.iteration === 1 ? "RUNNING" : "RETRYING";

    console.log(`\n--- Iteration ${run.iteration} / ${maxRetries} ---`);

    const result = opts.agentExecuteFn
      ? await opts.agentExecuteFn(task, opts.workspaceDir)
      : await runClaudeAgent(task, agentDir, { strategy });

    const invariantFailures = runInvariants(result, task);
    if (invariantFailures.length > 0) {
      const failure = invariantFailures[0]!;
      console.error("Invariant failed:", failure.type);
      strategy = mapFailureToStrategy(failure);
      console.log(`failure: ${failure.type} → strategy: ${strategy.action}`);

      if (strategy.action === "escalate") {
        recordStep(run, result, failure, strategy, "escalate");
        run.lastFailure = failure;
        run.state = "ESCALATED";
        writeEvidence(
          {
            taskId: task.id,
            iteration: run.iteration,
            verifyPass: false,
            verifyExitCode: -1,
            decision: "escalate",
            changedFiles: result.changedFiles,
            timestamp: Date.now(),
            failureType: failure.type,
            strategyAction: strategy.action,
          },
          opts.evidenceDir,
        );
        persistRun(run, opts.evidenceDir);
        throw new Error(`Task ${task.id} escalated: ${strategy.reason}`);
      }

      if (strategy.action === "rollback_and_retry") {
        console.log("rollback not yet implemented, retrying");
      }

      recordStep(run, result, failure, strategy, "reject");
      run.lastFailure = failure;

      writeEvidence(
        {
          taskId: task.id,
          iteration: run.iteration,
          verifyPass: false,
          verifyExitCode: -1,
          decision: "reject",
          changedFiles: result.changedFiles,
          timestamp: Date.now(),
          failureType: failure.type,
          strategyAction: strategy.action,
        },
        opts.evidenceDir,
      );

      if (run.iteration >= maxRetries) {
        run.state = "ESCALATED";
        break;
      }
      continue;
    }

    const vf = await runVerify(task.verify, opts.workspaceDir);

    if (vf !== null) {
      const summary = parseTestSummary(vf.logs);
      const regFailure = checkRegression(prevTestSummary, summary);
      prevTestSummary = summary;

      if (regFailure) {
        console.error("Regression detected:", regFailure.message);
        strategy = mapFailureToStrategy(regFailure);
        console.log(`failure: ${regFailure.type} → strategy: ${strategy.action}`);

        if (strategy.action === "escalate") {
          recordStep(run, result, regFailure, strategy, "escalate");
          run.lastFailure = regFailure;
          run.state = "ESCALATED";
          writeEvidence(
            {
              taskId: task.id,
              iteration: run.iteration,
              verifyPass: false,
              verifyExitCode: -1,
              decision: "escalate",
              changedFiles: result.changedFiles,
              timestamp: Date.now(),
              failureType: "REGRESSION",
              strategyAction: strategy.action,
            },
            opts.evidenceDir,
          );
          persistRun(run, opts.evidenceDir);
          throw new Error(`Task ${task.id} escalated: ${strategy.reason}`);
        }

        if (strategy.action === "rollback_and_retry") {
          console.log("rollback not yet implemented, retrying");
        }

        recordStep(run, result, regFailure, strategy, "reject");
        run.lastFailure = regFailure;

        writeEvidence(
          {
            taskId: task.id,
            iteration: run.iteration,
            verifyPass: false,
            verifyExitCode: -1,
            decision: "reject",
            changedFiles: result.changedFiles,
            timestamp: Date.now(),
            failureType: "REGRESSION",
            strategyAction: strategy.action,
          },
          opts.evidenceDir,
        );

        if (run.iteration >= maxRetries) {
          run.state = "ESCALATED";
          break;
        }
        continue;
      }

      strategy = mapFailureToStrategy(vf);
      console.log(`failure: ${vf.type} → strategy: ${strategy.action}`);
    } else {
      strategy = undefined;
      prevTestSummary = null;
    }

    writeEvidence(
      {
        taskId: task.id,
        iteration: run.iteration,
        verifyPass: vf === null,
        verifyExitCode: vf?.exitCode ?? 0,
        decision: vf === null ? "accept" : "retry",
        changedFiles: result.changedFiles,
        timestamp: Date.now(),
        failureType: vf?.type,
        strategyAction: strategy?.action,
      },
      opts.evidenceDir,
    );

    console.log(`verify: ${vf === null ? "PASS" : "FAIL"} (exit ${vf?.exitCode ?? 0})`);
    console.log(`decision: ${vf === null ? "accept" : "retry"}`);

    if (vf === null) {
      recordStep(run, result, undefined, undefined, "accept");
      run.state = "ACCEPTED";
      console.log("Task accepted.");
      break;
    }

    recordStep(run, result, vf, strategy, "retry");
    run.lastFailure = vf;

    if (run.iteration >= maxRetries) {
      run.state = "ESCALATED";
      break;
    }
  }

  persistRun(run, opts.evidenceDir);
  return run;
}
