/*
  Warnings:

  - A unique constraint covering the columns `[txHash,proposalId,voterType,drepId,spoId,ccId]` on the table `OnchainVote` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "OnchainVote_proposalId_voterType_drepId_spoId_ccId_key";

-- CreateIndex
CREATE UNIQUE INDEX "OnchainVote_txHash_proposalId_voterType_drepId_spoId_ccId_key" ON "OnchainVote"("txHash", "proposalId", "voterType", "drepId", "spoId", "ccId");
