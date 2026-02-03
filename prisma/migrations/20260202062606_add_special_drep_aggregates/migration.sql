/*
  Warnings:

  - A unique constraint covering the columns `[drep_id,action,epoch_no,tx_hash]` on the table `drep_lifecycle_event` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "epoch_totals" ADD COLUMN     "drep_always_abstain_delegator_count" INTEGER,
ADD COLUMN     "drep_always_abstain_voting_power" BIGINT,
ADD COLUMN     "drep_always_no_confidence_delegator_count" INTEGER,
ADD COLUMN     "drep_always_no_confidence_voting_power" BIGINT;

-- CreateIndex
CREATE UNIQUE INDEX "drep_lifecycle_event_drep_id_action_epoch_no_tx_hash_key" ON "drep_lifecycle_event"("drep_id", "action", "epoch_no", "tx_hash");
