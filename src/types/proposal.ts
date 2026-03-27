export type ProposalKind = "response" | "mutation" | "plan" | "classification";

export type Proposal<TUnit = unknown> = {
  id: string;
  kind: ProposalKind;
  units: TUnit[];
  metadata?: Record<string, unknown>;
};
