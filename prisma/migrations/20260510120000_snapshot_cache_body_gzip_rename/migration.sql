-- snapshot_cache: rename `body` -> `body_gzip` and add a `content_encoding`
-- column so the encoding contract is explicit at the schema layer and a
-- future migration can add e.g. "zstd" without another rename.
--
-- Both operations are PostgreSQL metadata-only:
--   - RENAME COLUMN is instant (no table rewrite).
--   - ADD COLUMN with a constant DEFAULT in PG 11+ is also instant.
-- Safe under concurrent reads/writes; no maintenance window required.

-- AlterTable
ALTER TABLE "snapshot_cache" RENAME COLUMN "body" TO "body_gzip";
ALTER TABLE "snapshot_cache" ADD COLUMN "content_encoding" TEXT NOT NULL DEFAULT 'gzip';
