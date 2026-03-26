import fs from "node:fs";
import path from "node:path";
import type { TaskSpec, ExecutionResult } from "../../types.js";

export type ScriptedStep = {
  description: string;
  changedFiles: string[];
  patch: string;
  logs: string;
  exitCode: number;
  writeFiles?: Record<string, string>; // relative path -> content to write to workspace
};

export class ScriptedMockAgent {
  private iteration = 0;

  constructor(private readonly script: ScriptedStep[]) {}

  async execute(task: TaskSpec, workspaceDir: string): Promise<ExecutionResult> {
    const step = this.script[this.iteration] ?? this.script[this.script.length - 1]!;
    this.iteration++;

    console.log(`[scripted-mock] iteration ${this.iteration}: ${step.description}`);

    // Write any file changes to workspace
    if (step.writeFiles) {
      for (const [relPath, content] of Object.entries(step.writeFiles)) {
        const fullPath = path.join(workspaceDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, "utf-8");
      }
    }

    // Suppress unused variable warning — task is part of the interface
    void task;

    return {
      patch: step.patch,
      changedFiles: step.changedFiles,
      logs: step.logs,
      exitCode: step.exitCode,
    };
  }
}
