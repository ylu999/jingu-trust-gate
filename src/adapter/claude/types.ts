export type ClaudeAdapterOptions = {
  timeoutMs?: number;
  strategyHint?: string;
  /** Set true to use the real Claude CLI instead of the mock. */
  real?: boolean;
};
