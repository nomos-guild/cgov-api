import type { Prisma, PrismaClient } from "@prisma/client";

export type DbSessionMode = "autocommit" | "transactional";

export type IngestionDbClient = Prisma.TransactionClient | PrismaClient;

export function getDbSessionMode(
  db: IngestionDbClient
): DbSessionMode {
  return "$transaction" in db ? "autocommit" : "transactional";
}
