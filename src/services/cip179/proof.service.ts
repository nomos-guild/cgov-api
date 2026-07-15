import { getBlockfrostService } from "../blockfrost";
import { prisma } from "../prisma";

type TxProof = import("cip-179/domain", { with: { "resolution-mode": "import" } }).TxProof;

async function loadCip179() {
  return (await import("../../libs/cip179Package.mjs")).loadCip179();
}

export async function transactionProof(txHash: string): Promise<TxProof | null> {
  const { tally, txproof, evolution } = await loadCip179();
  const cached = await prisma.cip179Transaction.findUnique({
    where: { txHash },
    select: { proof: true },
  });
  if (!cached) return null;
  if (cached.proof) {
    return tally.fromJsonSafe(JSON.parse(cached.proof)) as TxProof;
  }

  try {
    const response = await getBlockfrostService().get<{ cbor?: string }>(
      `/txs/${txHash}/cbor`
    );
    const proof = response.data.cbor
      ? txproof.decodeTxProof(evolution.evolutionCodec, response.data.cbor)
      : null;
    if (proof) {
      await prisma.cip179Transaction.update({
        where: { txHash },
        data: { proof: JSON.stringify(tally.toJsonSafe(proof)) },
      });
    }
    return proof;
  } catch (error) {
    console.warn(`[CIP-179] Transaction proof for ${txHash} will be retried:`, error);
    return null;
  }
}
