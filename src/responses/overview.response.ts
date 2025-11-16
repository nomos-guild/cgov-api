import { GovernanceAction, NCLData, ProposalSummary } from "../models";

export type GetNCLDataResponse = NCLData & ProposalSummary;

export type GetProposalListReponse = GovernanceAction[];
