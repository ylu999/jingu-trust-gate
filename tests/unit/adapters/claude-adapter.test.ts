import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeContextAdapter } from "../../../examples/integration/adapter-examples.js";
import type { VerifiedContext } from "../../../src/types/renderer.js";

function makeContext(overrides: Partial<VerifiedContext> = {}): VerifiedContext {
  return {
    admittedBlocks: [],
    summary: { admitted: 0, rejected: 0, conflicts: 0 },
    ...overrides,
  };
}

describe("ClaudeContextAdapter", () => {
  it("returns empty array for empty admittedBlocks", () => {
    const adapter = new ClaudeContextAdapter();
    const result = adapter.adapt(makeContext());
    assert.deepEqual(result, []);
  });

  it("converts a plain approved block", () => {
    const adapter = new ClaudeContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [{ sourceId: "claim-1", content: "You have milk" }],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "search_result");
    assert.equal(result[0].source, "claim-1");
    assert.equal(result[0].title, "claim-1");
    assert.equal(result[0].content[0].text, "You have milk");
    assert.deepEqual(result[0].citations, { enabled: true });
  });

  it("appends grade caveat for downgraded block", () => {
    const adapter = new ClaudeContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          { sourceId: "claim-1", content: "You have a drink", grade: "derived" },
        ],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.ok(
      result[0].content[0].text.includes("[Evidence grade: derived]"),
      "should include grade caveat"
    );
  });

  it("appends unsupportedAttributes note", () => {
    const adapter = new ClaudeContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          {
            sourceId: "claim-1",
            content: "You have a drink",
            grade: "derived",
            unsupportedAttributes: ["brand"],
          },
        ],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.ok(
      result[0].content[0].text.includes("[Not supported by evidence: brand]"),
      "should include unsupported attributes note"
    );
  });

  it("appends conflict note for approved_with_conflict block", () => {
    const adapter = new ClaudeContextAdapter();
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
    assert.ok(
      result[0].content[0].text.includes("[Conflict: contradicts claim-2]"),
      "should include conflict note"
    );
  });

  it("respects citations: false option", () => {
    const adapter = new ClaudeContextAdapter({ citations: false });
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [{ sourceId: "claim-1", content: "You have milk" }],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.deepEqual(result[0].citations, { enabled: false });
  });

  it("prepends sourcePrefix to source field", () => {
    const adapter = new ClaudeContextAdapter({ sourcePrefix: "gate:" });
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [{ sourceId: "claim-1", content: "You have milk" }],
        summary: { admitted: 1, rejected: 0, conflicts: 0 },
      })
    );
    assert.equal(result[0].source, "gate:claim-1");
  });

  it("converts multiple blocks preserving order", () => {
    const adapter = new ClaudeContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          { sourceId: "claim-1", content: "First" },
          { sourceId: "claim-2", content: "Second" },
          { sourceId: "claim-3", content: "Third" },
        ],
        summary: { admitted: 3, rejected: 0, conflicts: 0 },
      })
    );
    assert.equal(result.length, 3);
    assert.equal(result[0].source, "claim-1");
    assert.equal(result[1].source, "claim-2");
    assert.equal(result[2].source, "claim-3");
  });

  it("block with all caveats stacks them in order", () => {
    const adapter = new ClaudeContextAdapter();
    const result = adapter.adapt(
      makeContext({
        admittedBlocks: [
          {
            sourceId: "claim-1",
            content: "You have a drink",
            grade: "derived",
            unsupportedAttributes: ["brand", "quantity"],
            conflictNote: "contradicts claim-2",
          },
        ],
        summary: { admitted: 1, rejected: 0, conflicts: 1 },
      })
    );
    const text = result[0].content[0].text;
    assert.ok(text.startsWith("You have a drink"), "content comes first");
    assert.ok(text.includes("[Evidence grade: derived]"), "grade follows");
    assert.ok(
      text.includes("[Not supported by evidence: brand, quantity]"),
      "unsupported attrs follow"
    );
    assert.ok(text.includes("[Conflict: contradicts claim-2]"), "conflict note last");
  });
});
