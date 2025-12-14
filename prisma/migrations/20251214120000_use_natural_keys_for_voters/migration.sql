-- Make Drep.drepId, SPO.poolId and CC.ccId the primary keys
-- and drop the legacy surrogate id columns.

-- Drep: move primary key from id -> drepId and drop id column
ALTER TABLE "Drep" DROP CONSTRAINT "Drep_pkey";
ALTER TABLE "Drep" ADD CONSTRAINT "Drep_pkey" PRIMARY KEY ("drepId");

-- Drop the old surrogate id column
ALTER TABLE "Drep" DROP COLUMN "id";


-- SPO: move primary key from id -> poolId and drop id column
ALTER TABLE "SPO" DROP CONSTRAINT "SPO_pkey";
ALTER TABLE "SPO" ADD CONSTRAINT "SPO_pkey" PRIMARY KEY ("poolId");

ALTER TABLE "SPO" DROP COLUMN "id";


-- CC: move primary key from id -> ccId and drop id column
ALTER TABLE "CC" DROP CONSTRAINT "CC_pkey";
ALTER TABLE "CC" ADD CONSTRAINT "CC_pkey" PRIMARY KEY ("ccId");

ALTER TABLE "CC" DROP COLUMN "id";
