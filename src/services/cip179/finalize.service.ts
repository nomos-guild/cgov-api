import { prisma } from "../prisma";
import { koiosGet, koiosPost } from "../koios";
import { proposalSurvey } from "./survey.service";
import { transactionProof } from "./proof.service";
import type { ProposalSurveyResponse } from "../../types/cip179.types";

import { responseProven } from "./binding.service";
import { responderMembership } from "./membership.service";
import { cip179Network } from "./network";
const FINALIZATION_MARGIN_SECONDS = 600;

async function loadCip179() {
  return (await import("../../libs/cip179Package.mjs")).loadCip179();
}

type Credential = import("cip-179", { with: { "resolution-mode": "import" } }).Credential;
type ResponseRecord = import("cip-179/domain", { with: { "resolution-mode": "import" } }).ResponseRecord;
type SurveyBundle = import("cip-179/domain", { with: { "resolution-mode": "import" } }).SurveyBundle;
type WeightedResponder = import("cip-179/tally", { with: { "resolution-mode": "import" } }).WeightedResponder;

async function drepWeight(
  credential: Credential,
  epoch: number
): Promise<{ registered: boolean; weight: bigint }> {
  const { evolution } = await loadCip179();
  const drepId = evolution.evolutionCodec.drepId(credential);
  const rows = await koiosGet<Array<{ amount: string }>>(
    "/drep_voting_power_history",
    { _drep_id: drepId, epoch_no: `eq.${epoch}` },
    { source: "cip179.finalize.drep-weight" }
  );
  return { registered: true, weight: rows[0] ? BigInt(rows[0].amount) : 0n };
}

async function stakeholderWeight(
  credential: Credential,
  epoch: number
): Promise<{ registered: boolean; weight: bigint }> {
  const { evolution } = await loadCip179();
  const address = evolution.evolutionCodec.stakeAddress(credential, cip179Network().name);
  const stakes = await koiosPost<Array<{ active_stake: string }>>(
    `/account_stake_history?epoch_no=eq.${epoch}&select=active_stake`,
    { _stake_addresses: [address] }, { source: "cip179.finalize.stake-weight" });
  return { registered: true, weight: stakes[0] ? BigInt(stakes[0].active_stake) : 0n };
}

async function roleTotal(role: number, epoch: number): Promise<bigint | null> {
  try {
    if (role === 0) {
      const rows = await koiosGet<Array<{ amount: string | null }>>(
        "/drep_epoch_summary",
        { _epoch_no: epoch, select: "amount" },
        { source: "cip179.finalize.drep-total" }
      );
      return rows[0]?.amount ? BigInt(rows[0].amount) : null;
    }
    if (role === 3) {
      const rows = await koiosGet<Array<{ active_stake: string | null }>>(
        "/epoch_info",
        { _epoch_no: epoch, _include_next_epoch: false, select: "active_stake" },
        { source: "cip179.finalize.stake-total" }
      );
      return rows[0]?.active_stake ? BigInt(rows[0].active_stake) : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function weightedResponders(
  role: number,
  responses: ResponseRecord[],
  endEpoch: number
): Promise<WeightedResponder[] | null> {
  const { domain } = await loadCip179();
  const result: WeightedResponder[] = [];
  for (const record of responses.filter((item) => item.response.role === role)) {
    const membership =
      role === 0
        ? await drepWeight(record.response.credential, endEpoch)
        : role === 3
        ? await stakeholderWeight(record.response.credential, endEpoch)
        : { registered: true, weight: BigInt(1) };
    if (!membership.registered) continue;
    result.push({
      credentialKey: domain.credentialKey(record.response.credential),
      weight: membership.weight,
      txHash: record.txHash,
      responseIndex: record.responseIndex,
      response: record.response,
    });
  }
  return result;
}

async function finalizeSurvey(
  survey: ProposalSurveyResponse,
  assertLease: () => void
): Promise<boolean> {
  if (
    !survey.surveyRef ||
    !survey.linkValidation.valid ||
    survey.phase === "open" ||
    !survey.bundle
  ) return false;

  const { codec, domain, tally } = await loadCip179();
  const bundle = tally.fromJsonSafe(survey.bundle) as SurveyBundle;
  const definition = bundle.survey.definition;
  if (definition.submissionMode.type === "sealed" || definition.questions.some((q) => q.type === "custom")) return false;
  const deadline = domain.voteDeadlineUnix(
    definition.endEpoch,
    bundle.tip,
    cip179Network().secondsPerEpoch
  );
  if (Math.floor(Date.now() / 1000) < deadline + FINALIZATION_MARGIN_SECONDS) {
    return false;
  }
  const surveyKey = domain.refKey(bundle.survey.ref);
  if (await prisma.cip179Artifact.findUnique({ where: { surveyKey } })) return false;

  const coveredRoles = new Set<number>(tally.RULESET_DESCRIPTOR.coveredRoles);
  const candidates = bundle.responses.filter(
    (record) =>
      record.slot >= bundle.survey.slot &&
      record.epochNo <= definition.endEpoch &&
      record.response.answers.type === "public" && record.response.answers.answers.length > 0 &&
      coveredRoles.has(record.response.role) &&
      codec.validateResponse(definition, record.response).length === 0
  );
  if (candidates.some((record) => record.blockIndex === undefined)) {
    return false;
  }

  const cancellations = await Promise.all(
    bundle.cancellations
      .filter((record) => record.epochNo <= definition.endEpoch)
      .map(async (record) => ({
        ...record,
        proof: await transactionProof(record.txHash),
      }))
  );
  if (cancellations.some((record) => record.proof === null)) return false;
  const verifiedCancellation = cancellations
    .filter(
      (record) =>
        domain.cancellationVerified(definition.owner, record.proof)
    )
    .sort((left, right) => left.slot - right.slot || left.txHash.localeCompare(right.txHash))[0];

  let perRole: import("cip-179/tally", { with: { "resolution-mode": "import" } }).ArtifactRoleTally[] = [];
  if (!verifiedCancellation) {
    const proven: ResponseRecord[] = [];
    const membership = new Map();
    for (const record of candidates) {
      const proof = await transactionProof(record.txHash);
      if (!proof) return false;
      assertLease();
      if (await responseProven(record.response, proof, definition.endEpoch, survey.linkValidation.linkedActions) && await responderMembership(record, definition.endEpoch, membership)) {
        proven.push(record);
      }
    }
    const audited = domain.auditResponses(proven, definition).counted;
    const rolesPresent = [...new Set(audited.map((record) => record.response.role))]
      .filter((role) => coveredRoles.has(role))
      .sort((left, right) => left - right);
    for (const role of rolesPresent) {
      const responders = await weightedResponders(role, audited, definition.endEpoch);
      const total = await roleTotal(role, definition.endEpoch);
      if (!responders || (role !== 4 && total === null)) return false;
      perRole.push({
        role,
        total: total === null ? null : String(total),
        responders: tally.toArtifactResponders(responders),
        questions: tally.toArtifactQuestions(
          tally.weightedTallySurvey(definition, responders)
        ),
      });
    }
  }

  const body: import("cip-179/tally", { with: { "resolution-mode": "import" } }).TallyBody = {
    rulesetHash: tally.rulesetHash(),
    network: cip179Network().name,
    survey: {
      txId: survey.surveyRef.txId,
      index: survey.surveyRef.index,
      endEpoch: definition.endEpoch,
    },
    sealed: false,
    ...(verifiedCancellation
      ? {
          cancelled: {
            txHash: verifiedCancellation.txHash,
            slot: verifiedCancellation.slot,
            epoch: verifiedCancellation.epochNo,
          },
        }
      : {}),
    perRole,
  };
  const artifact = {
    tally: body,
    provenance: {
      source: {
        provider: "koios",
        baseUrl: process.env.KOIOS_BASE_URL ?? "https://api.koios.rest/api/v1",
      },
      fetchedAt: Math.floor(Date.now() / 1000),
      byRole: perRole.map(({ role }) => ({
        role,
        endpoint:
          role === 0
            ? "drep_voting_power_history"
            : role === 3
            ? "account_stake_history"
            : "local-count",
      })),
    },
  };
  assertLease();
  await prisma.cip179Artifact.create({
    data: {
      surveyKey,
      surveyTxId: survey.surveyRef.txId,
      surveyIndex: survey.surveyRef.index,
      endEpoch: definition.endEpoch,
      artifactHash: tally.artifactHash(body),
      artifact: JSON.stringify(artifact),
    },
  });
  return true;
}

export async function finalizeLinkedSurveys(assertLease: () => void = () => {}): Promise<number> {
  const [proposals, artifacts] = await Promise.all([
    prisma.proposal.findMany({
      where: { linkedSurveyTxId: { not: null }, linkedSurveyIndex: { not: null } },
      select: {
        proposalId: true,
        linkedSurveyTxId: true,
        linkedSurveyIndex: true,
      },
    }),
    prisma.cip179Artifact.findMany({ select: { surveyKey: true } }),
  ]);
  let finalized = 0;
  const seen = new Set(artifacts.map((artifact) => artifact.surveyKey));
  for (const proposal of proposals) {
    const storedKey = `${proposal.linkedSurveyTxId}:${proposal.linkedSurveyIndex}`;
    if (seen.has(storedKey)) continue;
    seen.add(storedKey);
    const survey = await proposalSurvey(proposal.proposalId);
    if (survey && (await finalizeSurvey(survey, assertLease))) finalized += 1;
  }
  return finalized;
}
