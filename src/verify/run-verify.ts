import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { VerifySpec } from "./verify-spec.js";
import type { VerifyFailure } from "../failure/types.js";

export function runVerify(spec: VerifySpec, workspaceDir: string): VerifyFailure | null {
  switch (spec.type) {
    case "command": {
      const [cmd, ...args] = spec.command.split(" ");
      let logs = "";
      let exitCode = 0;
      try {
        logs = execFileSync(cmd!, args, { cwd: workspaceDir, encoding: "utf8", timeout: 30_000 });
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        logs = (err.stdout ?? "") + (err.stderr ?? "");
        exitCode = err.status ?? 1;
      }
      const pass = exitCode === (spec.pass.exitCode ?? 0);
      if (pass) return null;
      return { type: "VERIFY_FAIL", logs, exitCode };
    }

    case "file_exists": {
      const fullPath = path.isAbsolute(spec.path) ? spec.path : path.join(workspaceDir, spec.path);
      const pass = fs.existsSync(fullPath);
      if (pass) return null;
      return { type: "VERIFY_FAIL", logs: `file_exists: ${spec.path} = false`, exitCode: 1 };
    }

    case "text_match": {
      const fullPath = path.isAbsolute(spec.path) ? spec.path : path.join(workspaceDir, spec.path);
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const pass = content.includes(spec.contains);
        if (pass) return null;
        return { type: "VERIFY_FAIL", logs: `text_match in ${spec.path}: false`, exitCode: 1 };
      } catch {
        return { type: "VERIFY_FAIL", logs: `text_match: file not found: ${spec.path}`, exitCode: 1 };
      }
    }

    case "json_schema": {
      const fullPath = path.isAbsolute(spec.path) ? spec.path : path.join(workspaceDir, spec.path);
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as unknown;
        const pass = typeof data === "object" && data !== null;
        if (pass) return null;
        return { type: "VERIFY_FAIL", logs: `json_schema: ${spec.path} valid=false`, exitCode: 1 };
      } catch (e) {
        return { type: "VERIFY_FAIL", logs: `json_schema: parse error: ${(e as Error).message}`, exitCode: 1 };
      }
    }

    case "all": {
      for (const check of spec.checks) {
        const failure = runVerify(check, workspaceDir);
        if (failure !== null) return failure;
      }
      return null;
    }

    case "any": {
      const failures: VerifyFailure[] = [];
      for (const check of spec.checks) {
        const failure = runVerify(check, workspaceDir);
        if (failure === null) return null;
        failures.push(failure);
      }
      return { type: "VERIFY_FAIL", logs: failures.map(f => f.logs).join("; "), exitCode: 1 };
    }

    default:
      throw new Error(`Unknown verify type: ${(spec as { type: string }).type}`);
  }
}
