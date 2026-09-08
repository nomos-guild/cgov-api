# CIP-179 chain-integrity repairs

Use the committed npm lockfile and Node 22.12 or newer. Local validation used
Node 22.23.2. The Dockerfile now installs that same lock and preserves the generated
Prisma client and Puppeteer browser when pruning development dependencies.

```sh
npm ci
npx prisma generate
npm run build
npm test
```

`npm run test:validation` runs the link/conversion suite and the Vitest pipeline,
native-CBOR and migration suites. Pipeline tests use real services and the pinned
CIP package with simulated database/provider boundaries. Native tests separately
decode independent CSL-signed CBOR and exercise exact integers, hash integrity,
address filtering and membership order. The migration test executes PostgreSQL
SQL in PGlite against representative existing tables; it is not a full production
schema or migration-history rehearsal. Standard endpoint tests bind local ports
with cron disabled. No live wallet or chain transaction is involved.

## Behavioral changes

- Native `/tx_cbor` decoding preserves integers, bytes and map keys, and checks the
  transaction body hash and auxiliary-data hash. Missing provider data and storage
  failures suspend finalization rather than becoming terminal malformed payloads.
- Every observed transaction refreshes its chain position and proof. A fixed scan
  watermark and stable ordering bound the scan, and a surviving block checkpoint
  is required before pruning rolled-back rows. Derived artifacts are rebuilt;
  readers withhold them while sync is running or has not completed successfully.
- DRep registration and Stakeholder registration/delegation are checked at both
  response inclusion and end_epoch, before latest-valid-response deduplication.
  Eligible zero-weight credentials remain eligible. Missing or ambiguous history
  keeps finalization pending.
- Governance links use the persisted on-chain URL/hash, verified raw document
  bytes and a supported inline CIP-108 body context. Missing mechanism-B proposal
  or anchor data remains unresolved. HTTPS connection addresses and redirects are
  restricted to public destinations; bodies and request durations are bounded.
- Survey references are uint16-bounded and indexed. Owner-proven cancellation
  remains cancelled after the deadline. The normal validation command runs tests.

## Deployment and recovery

1. Back up the database and rehearse migrations on a disposable copy. The earlier
   `20260712170000_cip179_v5` migration drops legacy draft-format survey columns.
   Its historical SQL is unchanged because it may already be applied. Preserve
   those legacy values in the backup **before** running that migration; the new
   migration cannot recover already-deleted values.
2. Apply `20260908000000_cip179_chain_integrity`. It adds proposal anchor fields,
   block identity and indexed survey references, clears only derived CIP artifacts,
   and marks CIP sync incomplete. Ordinary proposal and raw transaction rows remain.
3. Reingest proposals to populate `meta_url` and `meta_hash`, then run a complete
   CIP sync. Existing rows lacking those fields or a native block identity remain
   pending until reingestion. Do not mark sync successful by hand.
4. Set `CIP179_NETWORK` to `mainnet`, `preprod` or `preview` and point
   `KOIOS_BASE_URL` to the same network. Custom Koios hosts require an explicit
   network. Preview uses 86400-second epochs; mainnet/preprod use 432000.
   The selected provider must support native `/tx_cbor` and lifecycle endpoints.
5. Set `CIP179_SINCE_ISO` early enough to include all relevant definitions,
   responses and cancellations (default June 1, 2026 UTC). The current full scan
   stops at 50000 rows and reports partial, never complete, at that bound.
   Request batches respect the existing configured Koios body-size limit.
6. Keep the default strict sync lock enabled. Sync uses a 12-minute work budget
   inside its 15-minute lease. This is not a fencing-token protocol: multiple
   workers, long database stalls and lease expiry need separate fault testing.
   Run a single CIP sync worker during the deployment validation period.

Roll out the frontend and API together, then test actual Preview submission,
indexing, expiry, cancellation and rollback/re-inclusion. Do not return to an old
writer against the new data without a tested rollback procedure.

## Explicit scope and remaining checks

Public artifact roles are DRep, Stakeholder and Keyholder under CGov's application
ruleset. Custom and sealed aggregation, SPO/CC artifacts, general remote/compound
JSON-LD contexts and CIP-108 author-witness verification remain unsupported.
Link validation accepts the inline profile produced by these authoring tools;
unsupported context coercion is rejected rather than interpreted approximately.

Native-script reference resolution and timelock behavior have not been validated
against ledger acceptance. Full historical PostgreSQL migration, Docker image
execution, multi-worker/large-history fault testing and live provider behavior
remain deployment checks. Survey reads are indexed but not paginated within an
individual survey. The work-budget mechanism does not replace lease renewal or
strict fencing under arbitrarily delayed database operations.

The newly introduced Evolution/Undici path is overridden to patched 7.29.1.
The final npm audit still reports pre-existing dependency advisories; broad Mesh,
Puppeteer and other dependency upgrades require their own reachability review
and regression testing. Do not interpret passing CIP tests as absence of all
security issues in the complete application.
