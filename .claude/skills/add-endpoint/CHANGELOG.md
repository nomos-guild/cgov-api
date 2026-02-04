# add-endpoint Changelog

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
