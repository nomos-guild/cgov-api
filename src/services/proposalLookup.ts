import type { Prisma } from "@prisma/client";
import type { KoiosProposal } from "../types/koios.types";

export type ProposalIdentifierKind =
  | "proposalId"
  | "numericId"
  | "txHash"
  | "txHashAndIndex";

export interface ParsedProposalIdentifier {
  raw: string;
  normalized: string;
  kind: ProposalIdentifierKind;
  proposalId?: string;
  numericId?: number;
  txHash?: string;
  certIndex?: string;
}

const GOV_ACTION_IDENTIFIER_PREFIX = "gov_action";
const TX_HASH_REGEX = /^[0-9a-f]{64}$/i;
const NUMERIC_ID_REGEX = /^\d+$/;

export function parseProposalIdentifier(
  identifier: string
): ParsedProposalIdentifier | null {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith(GOV_ACTION_IDENTIFIER_PREFIX)) {
    return {
      raw: identifier,
      normalized: trimmed,
      kind: "proposalId",
      proposalId: trimmed,
    };
  }

  if (NUMERIC_ID_REGEX.test(trimmed)) {
    return {
      raw: identifier,
      normalized: trimmed,
      kind: "numericId",
      numericId: Number.parseInt(trimmed, 10),
    };
  }

  if (trimmed.includes(":")) {
    const [rawHash, rawIndex] = trimmed.split(":");
    const txHash = rawHash?.trim().toLowerCase();
    const certIndex = rawIndex?.trim();
    if (
      !txHash ||
      !certIndex ||
      !TX_HASH_REGEX.test(txHash) ||
      !NUMERIC_ID_REGEX.test(certIndex)
    ) {
      return null;
    }

    return {
      raw: identifier,
      normalized: `${txHash}:${certIndex}`,
      kind: "txHashAndIndex",
      txHash,
      certIndex,
    };
  }

  const txHash = trimmed.toLowerCase();
  if (!TX_HASH_REGEX.test(txHash)) {
    return null;
  }

  return {
    raw: identifier,
    normalized: txHash,
    kind: "txHash",
    txHash,
  };
}

export function buildProposalLookup(
  identifier: string
): Prisma.ProposalWhereInput | null {
  const parsed = parseProposalIdentifier(identifier);
  if (!parsed) {
    return null;
  }

  if (parsed.kind === "proposalId") {
    return { proposalId: parsed.proposalId! };
  }

  if (parsed.kind === "numericId") {
    return { id: parsed.numericId! };
  }

  if (parsed.kind === "txHashAndIndex") {
    return { txHash: parsed.txHash, certIndex: parsed.certIndex };
  }

  return { txHash: parsed.txHash };
}

export function findKoiosProposalForIdentifier(
  proposals: KoiosProposal[],
  parsed: ParsedProposalIdentifier
): KoiosProposal | undefined {
  if (parsed.kind === "proposalId" && parsed.proposalId) {
    return proposals.find((proposal) => proposal.proposal_id === parsed.proposalId);
  }

  if (parsed.kind === "txHashAndIndex" && parsed.txHash && parsed.certIndex) {
    return proposals.find(
      (proposal) =>
        proposal.proposal_tx_hash === parsed.txHash &&
        String(proposal.proposal_index) === parsed.certIndex
    );
  }

  if (parsed.txHash) {
    return proposals.find((proposal) => proposal.proposal_tx_hash === parsed.txHash);
  }

  return undefined;
}

export function getProposalIdentifierAliases(
  proposal: KoiosProposal
): string[] {
  return [
    proposal.proposal_id,
    proposal.proposal_tx_hash?.toLowerCase(),
    `${proposal.proposal_tx_hash?.toLowerCase()}:${String(proposal.proposal_index)}`,
  ].filter((value): value is string => Boolean(value));
}
