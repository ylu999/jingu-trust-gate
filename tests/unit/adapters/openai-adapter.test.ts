import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenAIContextAdapter } from "../../../examples/adapter-examples.js";
import type { VerifiedContext } from "../../../src/types/renderer.js";

function makeContext(overrides: Partial<VerifiedContext> = {}): VerifiedContext {
  return {
    admittedBlocks: [],
    summary: { admitted: 0, rejected: 0, conflicts: 0 },
    ...overrides,
  };
}

describe("OpenAIContextAdapter", () => {
  it("defaults to user role", () => {
    const adapter = new OpenAIContextAdapter();
    const result = adapter.adapt(makeContext());
    assert.equal(result.role, "user");
  });

  it("empty blocks produce empty content string", () => {
    const adapter = new OpenAIContextAdapter();
    const result = adapter.adapt(makeContext());
    assert.equal(result.content, "");
  });

  it("single block renders sourceId + content", () => {
    const adapter = new OpenAIContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [{ sourceId: "claim-1", content: "You have milk" }],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.ok(result.content.includes("[claim-1]"));
    assert.ok(result.content.includes("You have milk"));
  });

  it("downgraded block includes grade line", () => {
    const adapter = new OpenAIContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          { sourceId: "claim-1", content: "You have a drink", grade: "derived" },
        ],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.ok(result.content.includes("Evidence grade: derived"));
  });

  it("unsupportedAttributes line is included", () => {
    const adapter = new OpenAIContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          {
            sourceId: "claim-1",
            content: "You have a drink",
            unsupportedAttributes: ["brand"],
          },
        ],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.ok(result.content.includes("Not supported by evidence: brand"));
  });

  it("conflict note is included", () => {
    const adapter = new OpenAIContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          {
            sourceId: "claim-1",
            content: "You have milk",
            conflictNote: "contradicts claim-2",
          },
        ],
        summary: { admitted: 1, rejected: 0, conflicts: 1 },
      })
    );
    assert.ok(result.content.includes("Conflict: contradicts claim-2"));
  });

  it("tool mode sets role=tool and tool_call_id", () => {
    const adapter = new OpenAIContextAdapter({ mode: "tool", toolCallId: "call-abc" });
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [{ sourceId: "c1", content: "foo" }],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.equal(result.role, "tool");
    assert.equal(result.tool_call_id, "call-abc");
  });

  it("multiple blocks joined by separator", () => {
    const adapter = new OpenAIContextAdapter({ blockSeparator: "\n===\n" });
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          { sourceId: "c1", content: "First" },
          { sourceId: "c2", content: "Second" },
        ],
        summary: { admitted: 2, rejected: 0, conflicts: 0 },
      })
    );
    assert.ok(result.content.includes("\n===\n"), "should use custom separator");
    assert.ok(result.content.includes("[c1]"));
    assert.ok(result.content.includes("[c2]"));
  });
});
