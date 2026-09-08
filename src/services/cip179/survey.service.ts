import { prisma } from "../prisma";
import { koiosGet } from "../koios";
import { buildProposalLookup } from "../proposalLookup";
import {
  governanceActionEndEpoch,
  parseCip179Link,
} from "../../libs/cip179Link";
import type {
  ProposalSurveyResponse,
  ProposalSurveyTallyResponse,
} from "../../types/cip179.types";

async function loadCip179() {
  return (await import("../../libs/cip179Package.mjs")).loadCip179();
}

interface TipRow {
  epoch_no: number;
  abs_slot: number;
  epoch_slot: number;
  block_time: number;
}

type TxProof = import("cip-179/domain", {
  with: { "resolution-mode": "import" }
}).TxProof;

const unavailable = (
  linked: boolean,
  surveyRef: { txId: string; index: number } | null,
  errors: string[]
): ProposalSurveyResponse => ({
  linked,
  surveyRef,
  linkValidation: { valid: false, errors, linkedActions: [] },
  phase: "unavailable",
  bundle: null,
});

export async function proposalSurvey(
  proposalId: string
): Promise<ProposalSurveyResponse | null> {
  const lookup = buildProposalLookup(proposalId);
  if (!lookup) return null;
  const proposal = await prisma.proposal.findFirst({
    where: lookup,
    select: {
      proposalId: true,
      txHash: true,
      certIndex: true,
      metadata: true,
      expirationEpoch: true,
      linkedSurveyTxId: true,
      linkedSurveyIndex: true,
    },
  });
  if (!proposal) return null;

  const parsedLink = parseCip179Link(proposal.metadata);
  const surveyRef =
    parsedLink.surveyRef ??
    (proposal.linkedSurveyTxId !== null && proposal.linkedSurveyIndex !== null
      ? { txId: proposal.linkedSurveyTxId, index: proposal.linkedSurveyIndex }
      : null);
  if (!parsedLink.linked && !surveyRef) {
    return {
      linked: false,
      surveyRef: null,
      linkValidation: { valid: false, errors: [], linkedActions: [] },
      phase: "unavailable",
      bundle: null,
    };
  }
  if (!surveyRef || parsedLink.errors.length > 0) {
    return unavailable(true, null, parsedLink.errors);
  }

  const definitionTx = await prisma.cip179Transaction.findUnique({
    where: { txHash: surveyRef.txId },
  });
  if (!definitionTx) {
    return unavailable(true, surveyRef, ["Referenced survey transaction has not been indexed yet."]);
  }

  const { codec, domain, tally } = await loadCip179();
  const payload = tally.fromJsonSafe(JSON.parse(definitionTx.payload));
  if (!payload || typeof payload !== "object" || (payload as { type?: string }).type !== "definitions") {
    return unavailable(true, surveyRef, ["Referenced transaction does not contain survey definitions."]);
  }
  const definitions = (payload as { definitions: import("cip-179", { with: { "resolution-mode": "import" } }).SurveyDefinition[] }).definitions;
  const definition = definitions[surveyRef.index];
  if (!definition) {
    return unavailable(true, surveyRef, ["Referenced survey index does not exist in the definition transaction."]);
  }

  const errors = codec.validateDefinition(definition);
  if (definition.specVersion !== 5) errors.push("Referenced survey is not CIP-179 version 5.");
  if (definition.endEpoch <= definitionTx.epochNo) {
    errors.push("Survey end epoch was not in the future when its definition was published.");
  }
  const definitionProof = definitionTx.proof
    ? (tally.fromJsonSafe(JSON.parse(definitionTx.proof)) as import("cip-179/domain", { with: { "resolution-mode": "import" } }).TxProof)
    : null;
  if (!definitionProof) {
    errors.push("Survey definition owner proof has not been indexed yet.");
  } else if (!domain.cancellationVerified(definition.owner, definitionProof)) {
    errors.push("Survey definition transaction does not prove its declared owner credential.");
  }
  const actionEndEpoch = governanceActionEndEpoch(proposal.expirationEpoch);
  if (actionEndEpoch === null) {
    errors.push(
      "Governance action expiry is unavailable, so the survey link cannot be verified."
    );
  } else if (definition.endEpoch !== actionEndEpoch) {
    errors.push("Survey end epoch does not match the governance action's last active epoch.");
  }

  const linked = await prisma.proposal.findMany({
    where: {
      linkedSurveyTxId: surveyRef.txId,
      linkedSurveyIndex: surveyRef.index,
      expirationEpoch: definition.endEpoch + 1,
    },
    select: { proposalId: true },
  });
  const linkedActions = linked.map((item) => item.proposalId);
  if (errors.length > 0) {
    return {
      ...unavailable(true, surveyRef, errors),
      linkValidation: { valid: false, errors, linkedActions },
    };
  }

  const [rows, tips] = await Promise.all([
    prisma.cip179Transaction.findMany({ orderBy: { absoluteSlot: "asc" } }),
    koiosGet<TipRow[]>("/tip", undefined, { source: "cip179.survey.tip" }),
  ]);
  const tip = tips[0];
  if (!tip) return unavailable(true, surveyRef, ["Chain tip is unavailable."]);
  const key = `${surveyRef.txId}:${surveyRef.index}`;
  const responses: Array<Record<string, unknown>> = [];
  const cancellations: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const decoded = tally.fromJsonSafe(JSON.parse(row.payload)) as {
      type: string;
      responses?: Array<{ surveyRef: unknown }>;
      cancellations?: unknown[];
    };
    if (decoded.type === "responses") {
      decoded.responses?.forEach((response, responseIndex) => {
        if (domain.refKey(response.surveyRef as never) === key) {
          responses.push({
            txHash: row.txHash,
            slot: Number(row.absoluteSlot),
            epochNo: row.epochNo,
            ...(row.txBlockIndex !== null ? { blockIndex: row.txBlockIndex } : {}),
            responseIndex,
            response,
          });
        }
      });
    } else if (decoded.type === "cancellations") {
      const proof = row.proof
        ? (tally.fromJsonSafe(JSON.parse(row.proof)) as TxProof)
        : null;
      decoded.cancellations?.forEach((target) => {
        if (domain.refKey(target as never) === key) {
          cancellations.push({
            txHash: row.txHash,
            slot: Number(row.absoluteSlot),
            epochNo: row.epochNo,
            target,
            proof,
          });
        }
      });
    }
  }

  const bundle = {
    survey: {
      txHash: definitionTx.txHash,
      slot: Number(definitionTx.absoluteSlot),
      epochNo: definitionTx.epochNo,
      ref: { txId: domain.hexToBytes(surveyRef.txId), index: surveyRef.index },
      definition,
    },
    responses,
    cancellations,
    tip: {
      epoch: tip.epoch_no,
      slot: tip.abs_slot,
      time: tip.block_time,
      epochSlot: tip.epoch_slot,
      govActionLifetime: 0,
    },
  };
  const aggregate = domain.aggregateSurveys(
    {
      surveys: [bundle.survey],
      responses: responses as never,
      cancellations: cancellations as never,
    },
    bundle.tip
  )[0];

  return {
    linked: true,
    surveyRef,
    linkValidation: { valid: true, errors: [], linkedActions },
    phase: aggregate?.status === "cancelled" ? "cancelled" : definition.endEpoch < tip.epoch_no ? "closed" : "open",
    bundle: tally.toJsonSafe(bundle),
  };
}

export async function proposalSurveyTally(
  proposalId: string
): Promise<ProposalSurveyTallyResponse | null> {
  const survey = await proposalSurvey(proposalId);
  if (!survey) return null;
  if (!survey.linkValidation.valid || !survey.surveyRef) {
    return { phase: "finalization_pending", artifact: null, errors: survey.linkValidation.errors };
  }
  const bundle = survey.bundle as { survey?: { definition?: { submissionMode?: { type?: string } } } } | null;
  if (bundle?.survey?.definition?.submissionMode?.type === "sealed") {
    return { phase: "unsupported", artifact: null, errors: ["Sealed survey finalization is not supported by this CGov release."] };
  }
  const row = await prisma.cip179Artifact.findUnique({
    where: { surveyKey: `${survey.surveyRef.txId}:${survey.surveyRef.index}` },
  });
  if (row) {
    return { phase: "finalized", artifact: JSON.parse(row.artifact), errors: [] };
  }
  return {
    phase: survey.phase === "open" ? "open" : "finalization_pending",
    artifact: null,
    errors: [],
  };
}
