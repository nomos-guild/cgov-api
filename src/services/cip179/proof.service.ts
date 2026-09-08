import { koiosPost } from "../koios";
import { prisma } from "../prisma";

type TxProof = import("cip-179/domain", { with: { "resolution-mode": "import" } }).TxProof;

async function loadCip179() {
  return (await import("../../libs/cip179Package.mjs")).loadCip179();
}

export async function transactionProof(txHash: string): Promise<TxProof | null> {
  const { tally } = await loadCip179();
  const cached = await prisma.cip179Transaction.findUnique({
    where: { txHash },
    select: { proof: true },
  });
  if (!cached) return null;
  if (cached.proof) {
    return tally.fromJsonSafe(JSON.parse(cached.proof)) as TxProof;
  }

  try {
    const rows = await koiosPost<Array<{ tx_hash: string; cbor: string | null }>>("/tx_cbor", { _tx_hashes: [txHash] }, { source: "cip179.proof" });
    const row = rows.find((item) => item.tx_hash === txHash);
    const { decodeNativeTransaction } = await import("../../libs/cip179Package.mjs");
    const proof = row?.cbor ? (await decodeNativeTransaction(row.cbor, txHash)).proof : null;
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
