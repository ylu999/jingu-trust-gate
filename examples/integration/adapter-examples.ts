/**
 * Reference adapter implementations for jingu-trust-gate.
 *
 * These show how to implement ContextAdapter for Claude, OpenAI, and Gemini.
 * Copy and adapt as needed for your application — they are NOT part of the
 * core SDK.
 *
 * Usage:
 *   import { ClaudeContextAdapter } from "./examples/adapter-examples.js";
 */

import type { ContextAdapter } from "../../src/index.js";
import type { VerifiedBlock, VerifiedContext } from "../../src/types/renderer.js";


// ── Claude ─────────────────────────────────────────────────────────────────────

/**
 * Claude API search_result block shape.
 * Matches Anthropic SDK SearchResultBlockParam.
 */
export type ClaudeSearchResultBlock = {
  type: "search_result";
  source: string;
  title: string;
  content: Array<{ type: "text"; text: string }>;
  citations?: { enabled: boolean };
};

export type ClaudeAdapterOptions = {
  /** Whether to enable Claude's citation feature. Default: true. */
  citations?: boolean;
  /** Prefix for the source identifier. Default: none. */
  sourcePrefix?: string;
};

/**
 * Converts VerifiedContext → Claude API search_result blocks.
 *
 * Usage:
 *   const adapter = new ClaudeContextAdapter();
 *   const blocks = adapter.adapt(verifiedCtx);
 *   // Pass blocks as tool_result content or top-level user message content
 */
export class ClaudeContextAdapter implements ContextAdapter<ClaudeSearchResultBlock[]> {
  private readonly citations: boolean;
  private readonly sourcePrefix: string;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.citations = options.citations ?? true;
    this.sourcePrefix = options.sourcePrefix ?? "";
  }

  adapt(context: VerifiedContext): ClaudeSearchResultBlock[] {
    return context.admittedBlocks.map((block) => this.blockToSearchResult(block));
  }

  private blockToSearchResult(block: VerifiedBlock): ClaudeSearchResultBlock {
    const textParts: string[] = [block.content];
    if (block.grade) {
      textParts.push(`[Evidence grade: ${block.grade}]`);
    }
    if (block.unsupportedAttributes && block.unsupportedAttributes.length > 0) {
      textParts.push(`[Not supported by evidence: ${block.unsupportedAttributes.join(", ")}]`);
    }
    if (block.conflictNote) {
      textParts.push(`[Conflict: ${block.conflictNote}]`);
    }
    return {
      type: "search_result",
      source: `${this.sourcePrefix}${block.sourceId}`,
      title: block.sourceId,
      content: [{ type: "text", text: textParts.join("\n") }],
      citations: { enabled: this.citations },
    };
  }
}


// ── OpenAI ─────────────────────────────────────────────────────────────────────

/** OpenAI chat message — tool or user role. */
export type OpenAIChatMessage = {
  role: "tool" | "user";
  content: string;
  tool_call_id?: string;
};

export type OpenAIAdapterOptions = {
  /**
   * "tool"  — wrap as a tool result message (requires toolCallId).
   * "user"  — inject as a user-role message.
   * Default: "user"
   */
  mode?: "tool" | "user";
  toolCallId?: string;
  blockSeparator?: string;
};

/**
 * Converts VerifiedContext → OpenAI chat message.
 *
 * Usage (tool mode):
 *   const adapter = new OpenAIContextAdapter({ mode: "tool", toolCallId: call.id });
 *   messages.push(adapter.adapt(verifiedCtx));
 *
 * Usage (user mode):
 *   const adapter = new OpenAIContextAdapter();
 *   messages.push(adapter.adapt(verifiedCtx));
 */
export class OpenAIContextAdapter implements ContextAdapter<OpenAIChatMessage> {
  private readonly mode: "tool" | "user";
  private readonly toolCallId: string | undefined;
  private readonly blockSeparator: string;

  constructor(options: OpenAIAdapterOptions = {}) {
    this.mode = options.mode ?? "user";
    this.toolCallId = options.toolCallId;
    this.blockSeparator = options.blockSeparator ?? "\n\n---\n\n";
  }

  adapt(context: VerifiedContext): OpenAIChatMessage {
    const content = context.admittedBlocks
      .map((block) => this.blockToText(block))
      .join(this.blockSeparator);

    if (this.mode === "tool") {
      return { role: "tool", tool_call_id: this.toolCallId ?? "", content };
    }
    return { role: "user", content };
  }

  private blockToText(block: VerifiedBlock): string {
    const lines: string[] = [`[${block.sourceId}] ${block.content}`];
    if (block.grade) lines.push(`Evidence grade: ${block.grade}`);
    if (block.unsupportedAttributes && block.unsupportedAttributes.length > 0) {
      lines.push(`Not supported by evidence: ${block.unsupportedAttributes.join(", ")}`);
    }
    if (block.conflictNote) lines.push(`Conflict: ${block.conflictNote}`);
    return lines.join("\n");
  }
}


// ── Gemini ─────────────────────────────────────────────────────────────────────

export type GeminiTextPart = { text: string };

/** Gemini API Content object (one turn in the conversation). */
export type GeminiContent = {
  role: "user" | "model" | "function";
  parts: GeminiTextPart[];
};

export type GeminiAdapterOptions = {
  /** Default: "user" */
  role?: "user" | "function";
};

/**
 * Converts VerifiedContext → Gemini API Content object.
 *
 * Usage:
 *   const adapter = new GeminiContextAdapter();
 *   const content = adapter.adapt(verifiedCtx);
 *   const result = await model.generateContent({
 *     contents: [content, { role: "user", parts: [{ text: userQuery }] }],
 *   });
 */
export class GeminiContextAdapter implements ContextAdapter<GeminiContent> {
  private readonly role: "user" | "function";

  constructor(options: GeminiAdapterOptions = {}) {
    this.role = options.role ?? "user";
  }

  adapt(context: VerifiedContext): GeminiContent {
    if (context.admittedBlocks.length === 0) {
      return { role: this.role, parts: [{ text: "[No verified context available]" }] };
    }
    return {
      role: this.role,
      parts: context.admittedBlocks.map((block) => ({ text: this.blockToText(block) })),
    };
  }

  private blockToText(block: VerifiedBlock): string {
    const lines: string[] = [`[${block.sourceId}] ${block.content}`];
    if (block.grade) lines.push(`Evidence grade: ${block.grade}`);
    if (block.unsupportedAttributes && block.unsupportedAttributes.length > 0) {
      lines.push(`Not supported by evidence: ${block.unsupportedAttributes.join(", ")}`);
    }
    if (block.conflictNote) lines.push(`Conflict: ${block.conflictNote}`);
    return lines.join("\n");
  }
}
