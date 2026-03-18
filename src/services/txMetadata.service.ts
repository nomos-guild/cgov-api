import { koiosPost } from "./koios";
import type { KoiosTxMetadata } from "../types/koios.types";

export async function fetchTxMetadataByHash(
  txHash: string,
  context?: { source?: string }
): Promise<Record<string, unknown> | Array<Record<string, unknown>> | null> {
  if (!txHash) {
    return null;
  }

  const rows = await koiosPost<KoiosTxMetadata[]>("/tx_metadata", {
    _tx_hashes: [txHash],
  }, {
    source: context?.source ?? "tx-metadata.fetch-by-hash",
  });

  const row = rows?.[0];
  if (!row) {
    return null;
  }

  const metadata = row.json_metadata ?? row.metadata;
  if (!metadata) {
    return null;
  }

  return metadata;
}
