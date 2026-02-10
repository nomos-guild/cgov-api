# add-endpoint Changelog

## 1.2.0 (2026-02-04)

Journey-driven evolution from `2026-02-04-governance-analytics-endpoints.md`.

### Added
- **BigInt percentage calculations** pattern using scaled arithmetic (multiply by 10000n first)
- **Latest vote per voter** deduplication pattern for voters who can change their vote
- **Epoch time mapping** pattern for wall-clock calculations from epoch numbers
- **Analytics metrics** section with:
  - Gini coefficient for decentralization measurement
  - HHI (Herfindahl-Hirschman Index) for concentration
  - Contention score for close vote splits

## 1.1.0 (2026-02-04)

Journey-driven evolution from `2026-02-04-drep-dashboard-endpoints.md`.

### Added
- **Common Patterns section** with 4 reusable patterns discovered during DRep Dashboard implementation:
  - Vote/relation count aggregation via `groupBy` + in-memory join
  - `doNotList` filtering for nullable boolean fields
  - In-memory sorting for computed fields not in the DB
  - Aggregate stats with `_sum` for BigInt and Int fields

## 1.0.0 (2026-02-04)

- Initial version
