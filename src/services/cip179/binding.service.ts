import { prisma } from "../prisma";
import { buildProposalLookup } from "../proposalLookup";
import { fetchVerifiedAnchor } from "./anchor.service";
import {
  governanceActionEndEpoch,
  parseCip179Link,
} from "../../libs/cip179Link";

// prettier-ignore -- older formatters discard required Node16 import attributes.
type Response = import("cip-179", { with: { "resolution-mode": "import" } }).SurveyResponse;
// prettier-ignore
type Proof = import("cip-179/domain", { with: { "resolution-mode": "import" } }).TxProof;

/** Resolve otherwise-unproven mechanism-B actions before deciding a response is invalid.
 * Missing proposal ingestion or an unavailable anchor is an unresolved dependency,
 * not evidence that the governance action has no survey link.
 */
export async function responseProven(
  response: Response,
  proof: Proof,
  endEpoch: number,
  linkedActions: readonly string[],
): Promise<boolean> {
  const { domain } = await (
    await import("../../libs/cip179Package.mjs")
  ).loadCip179();
  if (domain.responseCredentialProven(response, proof, linkedActions))
    return true;
  const bindings = proof.votes.filter((binding) =>
    domain.responseCredentialProven(
      response,
      { ...proof, votes: [binding] },
      binding.actionIds,
    ),
  );
  for (const id of new Set(
    bindings.flatMap((binding) => [...binding.actionIds]),
  )) {
    const lookup = buildProposalLookup(id);
    if (!lookup)
      throw new Error(
        "Unresolved governance-action identifier in native proof",
      );
    const proposal = await prisma.proposal.findFirst({
      where: lookup,
      select: { expirationEpoch: true, metaUrl: true, metaHash: true },
    });
    if (!proposal)
      throw new Error("A response's governance action has not been indexed");
    const expiry = governanceActionEndEpoch(proposal.expirationEpoch);
    if (expiry === null)
      throw new Error("A response's governance action expiry is unavailable");
    if (expiry !== endEpoch) continue;
    const link = parseCip179Link(
      await fetchVerifiedAnchor(proposal.metaUrl, proposal.metaHash),
    );
    if (
      link.surveyRef &&
      `${link.surveyRef.txId}:${link.surveyRef.index}` ===
        domain.refKey(response.surveyRef)
    )
      return true;
  }
  return false;
}
