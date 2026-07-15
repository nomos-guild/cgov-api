export interface ProposalSurveyResponse {
  linked: boolean;
  surveyRef: { txId: string; index: number } | null;
  linkValidation: {
    valid: boolean;
    errors: string[];
    linkedActions: string[];
  };
  phase: "open" | "closed" | "cancelled" | "unavailable";
  bundle: unknown | null;
}

export interface ProposalSurveyTallyResponse {
  phase: "open" | "finalization_pending" | "finalized" | "unsupported";
  artifact: unknown | null;
  errors: string[];
}
