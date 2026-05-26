-- Backfill DRep.registered for rows that were inserted before the Koios
-- response handling was fixed. Koios /drep_info occasionally omits the
-- `registered` field even for currently-registered DReps, which the old
-- on-demand lookup (services/drep-lookup.ts) and hourly sync
-- (services/ingestion/drep-sync.service.ts) recorded verbatim as NULL.
--
-- A DRep with `active = true` and a populated `expires_epoch` must have a
-- current registration cert on chain (both fields are derived from it), so
-- `registered = true` is safe to assert in that case.

UPDATE drep
SET registered = true
WHERE registered IS NULL
  AND active = true
  AND expires_epoch IS NOT NULL;
