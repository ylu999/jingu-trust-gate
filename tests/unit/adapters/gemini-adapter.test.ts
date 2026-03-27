import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GeminiContextAdapter } from "../../../examples/adapter-examples.js";
import type { VerifiedContext } from "../../../src/types/renderer.js";

function makeContext(overrides: Partial<VerifiedContext> = {}): VerifiedContext {
  return {
    admittedBlocks: [],
    summary: { admitted: 0, rejected: 0, conflicts: 0 },
    ...overrides,
  };
}

describe("GeminiContextAdapter", () => {
  it("defaults to user role", () => {
    const adapter = new GeminiContextAdapter();
    const result = adapter.adapt(makeContext());
    assert.equal(result.role, "user");
  });

  it("empty blocks produce placeholder part", () => {
    const adapter = new GeminiContextAdapter();
    const result = adapter.adapt(makeContext());
    assert.equal(result.parts.length, 1);
    assert.ok(result.parts[0].text.includes("No verified context"));
  });

  it("one block per part (not concatenated)", () => {
    const adapter = new GeminiContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          { sourceId: "c1", content: "First" },
          { sourceId: "c2", content: "Second" },
        ],
        summary: { admitted: 2, rejected: 0, conflicts: 0 },
      })
    );
    assert.equal(result.parts.length, 2, "each block is a separate part");
    assert.ok(result.parts[0].text.includes("[c1]"));
    assert.ok(result.parts[1].text.includes("[c2]"));
  });

  it("downgraded block includes grade line in part text", () => {
    const adapter = new GeminiContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          { sourceId: "c1", content: "You have a drink", grade: "derived" },
        ],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.ok(result.parts[0].text.includes("Evidence grade: derived"));
  });

  it("unsupportedAttributes included in part text", () => {
    const adapter = new GeminiContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          {
            sourceId: "c1",
            content: "You have a drink",
            unsupportedAttributes: ["brand", "size"],
          },
        ],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.ok(result.parts[0].text.includes("Not supported by evidence: brand, size"));
  });

  it("conflict note included in part text", () => {
    const adapter = new GeminiContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          { sourceId: "c1", content: "You have milk", conflictNote: "contradicts c2" },
        ],
        summary: { admitted: 1, rejected: 0, conflicts: 1 },
      })
    );
    assert.ok(result.parts[0].text.includes("Conflict: contradicts c2"));
  });

  it("function role option is respected", () => {
    const adapter = new GeminiContextAdapter({ role: "function" });
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [{ sourceId: "c1", content: "foo" }],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.equal(result.role, "function");
  });
});
