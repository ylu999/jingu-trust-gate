import type { VerifiedContext } from "../types/renderer.js";

/**
 * ContextAdapter — converts VerifiedContext into the wire format
 * expected by a specific LLM API.
 *
 * gate.render() always outputs VerifiedContext (abstract semantic structure).
 * The adapter serializes that into whatever the target API needs.
 *
 * Implement this interface in your application code for each LLM provider you use.
 * See examples/adapter-examples.ts for Claude, OpenAI, and Gemini reference implementations.
 *
 * TOutput is the type accepted by the target LLM API client.
 */
export interface ContextAdapter<TOutput> {
  adapt(context: VerifiedContext): TOutput;
}
