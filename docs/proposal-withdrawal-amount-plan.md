# Treasury Withdrawal Amount Ingestion Plan

## Goal

Persist treasury withdrawal value directly on proposals so we can query withdrawal amounts without re-parsing Koios metadata each time.

## Scope

- Add `withdrawalAmount` to the `Proposal` Prisma model (`proposal.withdrawal_amount` in DB).
- Populate it during proposal ingestion from Koios data.
- Ensure this covers both:
  - cron sync (`syncAllProposals`)
  - sync-on-read (`syncProposalsOverviewOnRead`, `syncProposalDetailsOnRead`)

## Data Mapping Strategy

1. **Primary source**: `KoiosProposal.withdrawal.amount` (lovelace string).
2. **Fallback source**: `KoiosProposal.proposal_description.contents` for nested treasury withdrawal tuples.
3. Only map amount when `proposal_type === "TreasuryWithdrawals"`.
4. Store as `BigInt` (lovelace), nullable for non-treasury proposals.

## Implementation Checklist

- [x] Update Prisma schema: add `Proposal.withdrawalAmount BigInt? @map("withdrawal_amount")`.
- [x] Add SQL migration for `proposal.withdrawal_amount`.
- [x] Extend Koios proposal type to include `proposal_description` fallback structure.
- [x] Add ingestion helper to extract and normalize withdrawal amount.
- [x] Include `withdrawalAmount` in `proposal.upsert` create/update paths.
- [x] Confirm shared ingestion path is used by cron and sync-on-read flows.

## Validation Plan

1. Run Prisma migration and generate client:
   - `npx prisma migrate dev --name add_proposal_withdrawal_amount`
   - `npx prisma generate`
2. Run build/typecheck:
   - `npm run build`
3. Trigger proposal sync and verify:
   - Treasury withdrawal proposals have non-null `withdrawal_amount`
   - Non-treasury proposals remain `NULL`

## Notes

- Current API responses are unchanged; this update focuses on persistence and ingestion.
- `withdrawal_amount` is stored as lovelace to match other voting/treasury numeric fields.
