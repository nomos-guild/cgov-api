import { koiosGet, koiosPost } from "../koios";
import { cip179Network } from "./network";

// prettier-ignore -- older formatters discard required Node16 import attributes.
type Credential = import("cip-179", { with: { "resolution-mode": "import" } }).Credential;
// prettier-ignore
type ResponseRecord = import("cip-179/domain", { with: { "resolution-mode": "import" } }).ResponseRecord;
interface Event {
  action: string;
  epoch: number;
  slot: number;
  index: number;
  certIndex: number;
  txHash: string;
}
interface Position {
  tx_hash: string;
  absolute_slot: number;
  epoch_no: number;
  tx_block_index: number;
}
const PAGE = 100;

async function positions(hashes: string[]): Promise<Map<string, Position>> {
  const found = new Map<string, Position>();
  // Three hashes fit even the client's minimum configurable 256-byte body cap.
  for (let offset = 0; offset < hashes.length; offset += 3) {
    const batch = hashes.slice(offset, offset + 3);
    const rows = await koiosPost<Position[]>(
      "/tx_info?select=tx_hash,absolute_slot,epoch_no,tx_block_index",
      { _tx_hashes: batch },
      { source: "cip179.membership.position" },
    );
    for (const row of rows) {
      if (
        ![row.absolute_slot, row.epoch_no, row.tx_block_index].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        )
      )
        throw new Error("Membership position is incomplete");
      found.set(row.tx_hash, row);
    }
    if (batch.some((hash) => !found.has(hash)))
      throw new Error("Membership transaction is missing");
  }
  return found;
}

async function history(credential: Credential, role: number): Promise<Event[]> {
  const { evolution } = await (
    await import("../../libs/cip179Package.mjs")
  ).loadCip179();
  const rows: Array<{ action: string; txHash: string; certIndex: number }> = [];
  for (let offset = 0; ; offset += PAGE) {
    if (offset >= 10_000)
      throw new Error("Membership history exceeds this sync's bound");
    if (role === 0) {
      const page = await koiosGet<
        Array<{ action: string; update_tx_hash: string; cert_index: number }>
      >(
        "/drep_updates",
        {
          _drep_id: evolution.evolutionCodec.drepId(credential),
          select: "action,update_tx_hash,cert_index",
          order: "update_tx_hash.asc,cert_index.asc",
          limit: PAGE,
          offset,
        },
        { source: "cip179.membership.drep" },
      );
      for (const item of page) {
        if (
          !["registered", "deregistered", "updated"].includes(item.action) ||
          !Number.isSafeInteger(item.cert_index)
        )
          throw new Error("Unknown DRep lifecycle event");
        rows.push({
          action: item.action,
          txHash: item.update_tx_hash,
          certIndex: item.cert_index,
        });
      }
      if (page.length < PAGE) break;
    } else {
      const address = evolution.evolutionCodec.stakeAddress(
        credential,
        cip179Network().name,
      );
      const page = await koiosPost<
        Array<{ action_type: string; tx_hash: string }>
      >(
        `/account_update_history?select=action_type,tx_hash&order=tx_hash.asc,action_type.asc&limit=${PAGE}&offset=${offset}`,
        { _stake_addresses: [address] },
        { source: "cip179.membership.stake" },
      );
      for (const item of page)
        rows.push({
          action: item.action_type,
          txHash: item.tx_hash,
          certIndex: 0,
        });
      if (page.length < PAGE) break;
    }
  }
  const chain = await positions([...new Set(rows.map((row) => row.txHash))]);
  const events = rows.map((row) => {
    const p = chain.get(row.txHash)!;
    return {
      ...row,
      epoch: p.epoch_no,
      slot: p.absolute_slot,
      index: p.tx_block_index,
    };
  });
  if (role === 3) {
    // Koios's account history omits certificate indexes. Refuse ambiguous
    // deregistration/re-registration or delegation within one transaction.
    for (const hash of new Set(events.map((event) => event.txHash))) {
      const actions = events
        .filter((event) => event.txHash === hash)
        .map((event) => event.action);
      if (
        actions.includes("deregistration") &&
        actions.some(
          (action) =>
            action === "registration" || action.startsWith("delegation_"),
        )
      )
        throw new Error(
          "Ambiguous stake certificate order; native lifecycle indexing is required",
        );
    }
  }
  return events.sort(
    (a, b) =>
      a.slot - b.slot ||
      a.index - b.index ||
      a.certIndex - b.certIndex ||
      (a.action === "registration"
        ? -1
        : b.action === "registration"
          ? 1
          : a.action.localeCompare(b.action)),
  );
}

export function eligibleAt(
  events: readonly Event[],
  role: number,
  epoch: number,
  position?: { slot: number; index: number },
): boolean {
  let registered = false,
    delegated = false;
  for (const event of events) {
    if (
      event.epoch > epoch ||
      (position &&
        (event.slot > position.slot ||
          (event.slot === position.slot && event.index > position.index)))
    )
      continue;
    if (event.action === "registered" || event.action === "registration")
      registered = true;
    if (event.action === "deregistered" || event.action === "deregistration") {
      registered = false;
      delegated = false;
    }
    if (
      event.action === "delegation_pool" ||
      event.action === "delegation_drep"
    )
      delegated = true;
  }
  return registered && (role !== 3 || delegated);
}

/** Fetch once per credential during finalization; never infer membership from weight. */
export async function responderMembership(
  record: ResponseRecord,
  endEpoch: number,
  cached: Map<string, Event[]>,
): Promise<boolean> {
  const { domain } = await (
    await import("../../libs/cip179Package.mjs")
  ).loadCip179();
  const role = record.response.role;
  if (role === 4) return true;
  if (role !== 0 && role !== 3) return false;
  const key = `${role}:${domain.credentialKey(record.response.credential)}`;
  let events = cached.get(key);
  if (!events) {
    events = await history(record.response.credential, role);
    cached.set(key, events);
  }
  if (record.blockIndex === undefined)
    throw new Error("Response block index is unavailable");
  return (
    eligibleAt(events, role, record.epochNo, {
      slot: record.slot,
      index: record.blockIndex,
    }) && eligibleAt(events, role, endEpoch)
  );
}
