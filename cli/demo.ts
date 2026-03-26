import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadTask } from "../src/loader/load-task.js";
import { runTask } from "../src/runtime/run-task.js";
import { ScriptedMockAgent } from "../src/adapter/claude/scripted-mock.js";
import type { ScriptedStep } from "../src/adapter/claude/scripted-mock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When compiled, the file is at dist/cli/demo.js — go up two levels to reach project root
const repoRoot = path.resolve(__dirname, "..", "..");
const DEMO_DIR = path.join(repoRoot, "examples", "demo");
const WORKSPACE = path.join(DEMO_DIR, "repo");

// Reset add.js to broken state before demo
fs.writeFileSync(
  path.join(WORKSPACE, "src", "add.js"),
  "export function add(a, b) {\n  return a - b; // bug\n}\nexport function multiply(a, b) {\n  return a * b;\n}\n",
  "utf-8",
);

const SCRIPT: ScriptedStep[] = [
  {
    // Iteration 1: agent writes nothing meaningful — add still broken, multiply OK
    // verify runs node --test: add fails (1 failure) → VERIFY_FAIL
    description: "Iteration 1: wrong fix — does not actually repair add()",
    changedFiles: ["src/add.js"],
    patch: "--- a/src/add.js\n+++ b/src/add.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b; // bug\n+  return a - b; // still wrong\n }",
    logs: "agent attempted fix but misidentified the issue",
    exitCode: 0,
    // No writeFiles — add.js stays broken. Verify will fail: 1 failure (add).
  },
  {
    // Iteration 2: agent attempts fix but accidentally breaks multiply too
    // verify runs node --test: BOTH add and multiply fail (2 failures)
    // checkRegression: prev=1, current=2 → 2 > 1 → REGRESSION
    description: "Iteration 2: regression — agent breaks multiply while fixing add",
    changedFiles: ["src/add.js"],
    patch: "--- a/src/add.js\n+++ b/src/add.js\n@@ -1,5 +1,5 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n export function multiply(a, b) {\n-  return a * b;\n+  return a / b;\n }",
    logs: "agent refactored both functions — introduced regression in multiply",
    exitCode: 0,
    writeFiles: {
      // add is fixed, but multiply is broken — 2 tests still fail (multiply)
      // Wait: if add is fixed, only multiply fails = 1 failure, same as before.
      // To get REGRESSION (current > prev), we need multiply broken AND add still wrong.
      "src/add.js":
        "export function add(a, b) {\n  return a - b; // still broken\n}\nexport function multiply(a, b) {\n  return a / b; // regression introduced\n}\n",
    },
  },
  {
    // Iteration 3: correct fix — add returns a+b, multiply unchanged
    // verify runs node --test: both pass → ACCEPT
    description: "Iteration 3: correct fix — add returns a+b, multiply restored",
    changedFiles: ["src/add.js"],
    patch: "--- a/src/add.js\n+++ b/src/add.js\n@@ -1,5 +1,5 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n export function multiply(a, b) {\n-  return a / b;\n+  return a * b;\n }",
    logs: "agent fixed both add (returns a+b) and restored multiply (returns a*b)",
    exitCode: 0,
    writeFiles: {
      "src/add.js":
        "export function add(a, b) {\n  return a + b;\n}\nexport function multiply(a, b) {\n  return a * b;\n}\n",
    },
  },
];

async function main() {
  console.log("═".repeat(60));
  console.log("  Jingu Harness — Demo");
  console.log("  AI tries to fix a bug, Jingu governs the outcome");
  console.log("═".repeat(60));

  const task = loadTask(path.join(DEMO_DIR, "task.json"));
  const agent = new ScriptedMockAgent(SCRIPT);

  const run = await runTask(task, {
    workspaceDir: WORKSPACE,
    evidenceDir: ".jingu",
    agentExecuteFn: (t, wd) => agent.execute(t, wd),
  });

  console.log("\n" + "═".repeat(60));
  console.log(`  Final state : ${run.state}`);
  console.log(`  Run ID      : ${run.id}`);
  console.log(`  Iterations  : ${run.history.length}`);
  console.log("═".repeat(60));
  console.log("\nOpen the Explorer to view the run:");
  console.log("  npm run explorer");
  console.log("  http://localhost:3000");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
