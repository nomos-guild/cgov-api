/**
 * Single-writer coordination for delegation sync using PostgreSQL advisory locks.
 * pg_try_advisory_lock is process-wide on the DB session; pair with release after work.
 */

import { Prisma } from "@prisma/client";

/** Stable bigint key for delegation ingestion (arbitrary, must not collide with other advisory lock users). */
const DELEGATION_WRITER_ADVISORY_LOCK_KEY = BigInt("9081726354619283745");

export async function tryAcquireDelegationWriterLock(prisma: {
  $queryRaw: (query: TemplateStringsArray | Prisma.Sql) => Promise<unknown>;
}): Promise<boolean> {
  const rows = (await prisma.$queryRaw(
    Prisma.sql`SELECT pg_try_advisory_lock(${DELEGATION_WRITER_ADVISORY_LOCK_KEY}) AS acquired`
  )) as Array<{ acquired: boolean }>;
  return rows[0]?.acquired === true;
}

export async function releaseDelegationWriterLock(prisma: {
  $queryRaw: (query: TemplateStringsArray | Prisma.Sql) => Promise<unknown>;
}): Promise<void> {
  await prisma.$queryRaw(
    Prisma.sql`SELECT pg_advisory_unlock(${DELEGATION_WRITER_ADVISORY_LOCK_KEY})`
  );
}
