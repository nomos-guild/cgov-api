import { prisma, withDbRead, withDbWrite } from "../prisma";

const KOIOS_COORDINATION_JOB_NAME = "koios-shared-coordination";
const KOIOS_COORDINATION_DISPLAY_NAME = "Koios Shared Coordination";

interface KoiosSharedCursor {
  backoffUntil: number;
  pressureCooldownUntil: number;
  timeoutCooldownUntil: number;
  updatedAt: string;
}

export interface KoiosSharedCooldownSnapshot {
  backoffUntil: number;
  pressureCooldownUntil: number;
  timeoutCooldownUntil: number;
  updatedAt: string;
}

export interface KoiosSharedCooldownPatch {
  backoffUntil?: number;
  pressureCooldownUntil?: number;
  timeoutCooldownUntil?: number;
  source?: string;
}

function emptySnapshot(): KoiosSharedCooldownSnapshot {
  return {
    backoffUntil: 0,
    pressureCooldownUntil: 0,
    timeoutCooldownUntil: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function parseCursor(raw: string | null | undefined): KoiosSharedCooldownSnapshot {
  if (!raw) return emptySnapshot();
  try {
    const parsed = JSON.parse(raw) as Partial<KoiosSharedCursor>;
    return {
      backoffUntil: normalizeTimestamp(parsed.backoffUntil),
      pressureCooldownUntil: normalizeTimestamp(parsed.pressureCooldownUntil),
      timeoutCooldownUntil: normalizeTimestamp(parsed.timeoutCooldownUntil),
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return emptySnapshot();
  }
}

function buildMergedSnapshot(
  base: KoiosSharedCooldownSnapshot,
  patch: KoiosSharedCooldownPatch
): KoiosSharedCooldownSnapshot {
  const nowIso = new Date().toISOString();
  return {
    backoffUntil: Math.max(base.backoffUntil, normalizeTimestamp(patch.backoffUntil)),
    pressureCooldownUntil: Math.max(
      base.pressureCooldownUntil,
      normalizeTimestamp(patch.pressureCooldownUntil)
    ),
    timeoutCooldownUntil: Math.max(
      base.timeoutCooldownUntil,
      normalizeTimestamp(patch.timeoutCooldownUntil)
    ),
    updatedAt: nowIso,
  };
}

export async function getKoiosSharedCooldownSnapshot(): Promise<KoiosSharedCooldownSnapshot> {
  return withDbRead("koios-shared-cooldown.read", async () => {
    const row = await prisma.syncStatus.findUnique({
      where: { jobName: KOIOS_COORDINATION_JOB_NAME },
      select: { backfillCursor: true },
    });
    return parseCursor(row?.backfillCursor);
  });
}

export async function mergeKoiosSharedCooldown(
  patch: KoiosSharedCooldownPatch
): Promise<KoiosSharedCooldownSnapshot> {
  return withDbWrite("koios-shared-cooldown.merge", async () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "sync_status" ("job_name", "display_name", "is_running", "created_at", "updated_at")
        VALUES (${KOIOS_COORDINATION_JOB_NAME}, ${KOIOS_COORDINATION_DISPLAY_NAME}, false, NOW(), NOW())
        ON CONFLICT ("job_name") DO NOTHING
      `;

      const rows = await tx.$queryRaw<Array<{ backfill_cursor: string | null }>>`
        SELECT "backfill_cursor"
        FROM "sync_status"
        WHERE "job_name" = ${KOIOS_COORDINATION_JOB_NAME}
        FOR UPDATE
      `;

      const current = parseCursor(rows[0]?.backfill_cursor ?? null);
      const merged = buildMergedSnapshot(current, patch);

      await tx.syncStatus.update({
        where: { jobName: KOIOS_COORDINATION_JOB_NAME },
        data: {
          displayName: KOIOS_COORDINATION_DISPLAY_NAME,
          isRunning: false,
          backfillCursor: JSON.stringify(merged),
          errorMessage: patch.source
            ? `last-source=${patch.source}`
            : undefined,
        },
      });

      return merged;
    })
  );
}
