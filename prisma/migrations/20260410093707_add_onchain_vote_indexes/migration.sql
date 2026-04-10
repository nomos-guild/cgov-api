-- CreateIndex
CREATE INDEX "onchain_vote_drep_id_idx" ON "onchain_vote"("drep_id");

-- CreateIndex
CREATE INDEX "onchain_vote_proposal_id_idx" ON "onchain_vote"("proposal_id");

-- CreateIndex
CREATE INDEX "onchain_vote_voter_type_idx" ON "onchain_vote"("voter_type");

-- CreateIndex
CREATE INDEX "onchain_vote_voted_at_idx" ON "onchain_vote"("voted_at" DESC);
