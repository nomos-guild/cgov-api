import type { Prisma, PrismaClient } from "@prisma/client";
import { withDbRead, withDbWrite } from "../prisma";

export type DbSessionMode = "autocommit" | "transactional";

export type IngestionDbClient = Prisma.TransactionClient | PrismaClient;

export function getDbSessionMode(
  db: IngestionDbClient
): DbSessionMode {
  return "$transaction" in db ? "autocommit" : "transactional";
}

/**
 * Applies shared DB resilience only for autocommit clients.
 * Transaction clients should run directly to avoid retrying inside an open tx.
 */
export async function withIngestionDbRead<T>(
  db: IngestionDbClient,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  if (getDbSessionMode(db) === "transactional") {
    return fn();
  }
  return withDbRead(operation, fn);
}

/**
 * Applies shared DB resilience only for autocommit clients.
 * Transaction clients should run directly to avoid retrying inside an open tx.
 */
export async function withIngestionDbWrite<T>(
  db: IngestionDbClient,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  if (getDbSessionMode(db) === "transactional") {
    return fn();
  }
  return withDbWrite(operation, fn);
}
