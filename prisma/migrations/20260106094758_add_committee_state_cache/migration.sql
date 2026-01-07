-- CreateTable
CREATE TABLE "committee_state" (
    "id" TEXT NOT NULL DEFAULT 'current',
    "epoch" INTEGER NOT NULL,
    "total_members" INTEGER NOT NULL,
    "eligible_members" INTEGER NOT NULL,
    "quorum_numerator" INTEGER NOT NULL,
    "quorum_denominator" INTEGER NOT NULL,
    "is_committee_valid" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "committee_state_pkey" PRIMARY KEY ("id")
);
