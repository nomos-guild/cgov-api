/*
  Warnings:

  - You are about to drop the column `stakeKey` on the `Drep` table. All the data in the column will be lost.
  - You are about to drop the column `discordId` on the `User` table. All the data in the column will be lost.
  - Added the required column `txHash` to the `OnchainVote` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "OnchainVote" DROP CONSTRAINT "OnchainVote_ccId_fkey";

-- DropForeignKey
ALTER TABLE "OnchainVote" DROP CONSTRAINT "OnchainVote_drepId_fkey";

-- DropForeignKey
ALTER TABLE "OnchainVote" DROP CONSTRAINT "OnchainVote_proposalId_fkey";

-- DropForeignKey
ALTER TABLE "OnchainVote" DROP CONSTRAINT "OnchainVote_spoId_fkey";

-- DropIndex
DROP INDEX "User_discordId_key";

-- AlterTable
ALTER TABLE "Drep" DROP COLUMN "stakeKey",
ADD COLUMN     "doNotList" BOOLEAN,
ADD COLUMN     "iconUrl" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "paymentAddress" TEXT;

-- AlterTable
ALTER TABLE "OnchainVote" ADD COLUMN     "txHash" TEXT NOT NULL,
ALTER COLUMN "proposalId" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "SPO" ADD COLUMN     "iconUrl" TEXT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "discordId";

-- AddForeignKey
ALTER TABLE "OnchainVote" ADD CONSTRAINT "OnchainVote_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("proposalId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnchainVote" ADD CONSTRAINT "OnchainVote_drepId_fkey" FOREIGN KEY ("drepId") REFERENCES "Drep"("drepId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnchainVote" ADD CONSTRAINT "OnchainVote_spoId_fkey" FOREIGN KEY ("spoId") REFERENCES "SPO"("poolId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnchainVote" ADD CONSTRAINT "OnchainVote_ccId_fkey" FOREIGN KEY ("ccId") REFERENCES "CC"("ccId") ON DELETE SET NULL ON UPDATE CASCADE;
