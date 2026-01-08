import {
  PrismaClient,
  VoteType,
  VoterType,
  GovernanceType,
  ProposalStatus,
} from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting database seed...");

  // Clean existing data (optional - comment out if you want to keep existing data)
  console.log("🧹 Cleaning existing data...");
  await prisma.onchainVote.deleteMany({});
  await prisma.proposal.deleteMany({});
  await prisma.drep.deleteMany({});
  await prisma.sPO.deleteMany({});
  await prisma.cC.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.crowdfundingCampaign.deleteMany({});
  await prisma.proposalDraft.deleteMany({});

  // Create Users
  console.log("👤 Creating users...");
  const user1 = await prisma.user.create({
    data: {
      id: "user-1",
      walletAddress:
        "addr1qxy3w6z5abc123def456ghi789jkl012mno345pqr678stu901vwx234yz",
      stakeKeyLovelace: 1_000_000,
      jwt: "mock-jwt-token-user1",
    },
  });

  const user2 = await prisma.user.create({
    data: {
      id: "user-2",
      walletAddress:
        "addr1qab2cd3ef4gh5ij6kl7mn8op9qr0st1uv2wx3yz4ab5cd6ef",
      stakeKeyLovelace: 2_500_000,
      jwt: "mock-jwt-token-user2",
    },
  });

  const user3 = await prisma.user.create({
    data: {
      id: "user-3",
      walletAddress:
        "addr1qzz9yy8xx7ww6vv5uu4tt3ss2rr1qq0pp9oo8nn7mm6ll5kk",
      stakeKeyLovelace: 5_000_000,
      jwt: "mock-jwt-token-user3",
    },
  });

  // Create DReps
  console.log("🗳️  Creating DReps...");
  const drep1 = await prisma.drep.create({
    data: {
      drepId: "drep1abc123def456ghi789jkl012mno345pqr678stu901vwx234yz",
      userId: user1.id,
      paymentAddr: "stake1abc123def456",
      votingPower: BigInt(1_500_000),
      name: "Seed DRep 1",
    },
  });

  const drep2 = await prisma.drep.create({
    data: {
      drepId: "drep1xyz789uvw456rst123opq890lmn567ijk345fgh012cde678",
      paymentAddr: "stake1xyz789uvw456",
      votingPower: BigInt(3_200_000),
      name: "Seed DRep 2",
    },
  });

  // Create SPOs
  console.log("🏊 Creating SPOs...");
  const spo1 = await prisma.sPO.create({
    data: {
      poolId:
        "pool1qwertyuiopasdfghjklzxcvbnm1234567890abcdefghijklmno",
      userId: user2.id,
      poolName: "Cardano Stake Pool Alpha",
      ticker: "ALPHA",
      votingPower: BigInt(10_000_000),
    },
  });

  const spo2 = await prisma.sPO.create({
    data: {
      poolId:
        "pool1mnbvcxzlkjhgfdsapoiuytrewq0987654321zyxwvutsrqpo",
      poolName: "Beta Pool",
      ticker: "BETA",
      votingPower: BigInt(8_500_000),
    },
  });

  // Create CC Members
  console.log("🏛️  Creating Constitutional Committee members...");
  const cc1 = await prisma.cC.create({
    data: {
      ccId: "cc1_abc123def456ghi789jkl012mno345pqr678",
      userId: user3.id,
      memberName: "Alice Johnson",
      hotCredential: "hot_cred_alice123",
      coldCredential: "cold_cred_alice456",
      status: "Active",
    },
  });

  const cc2 = await prisma.cC.create({
    data: {
      ccId: "cc1_xyz789uvw456rst123opq890lmn567ijk",
      memberName: "Bob Smith",
      hotCredential: "hot_cred_bob789",
      coldCredential: "cold_cred_bob012",
      status: "Active",
    },
  });

  // Create Proposals
  console.log("📋 Creating proposals...");
  const proposal1 = await prisma.proposal.create({
    data: {
      proposalId:
        "gov_action1zhuz5djmmmjg8f9s8pe6grfc98xg3szglums8cgm6qwancp4eytqqmpu0pr",
      txHash:
        "15f82a365bdee483a4b03873a40d3829cc88c048ff3703e11bd01dd9e035c916",
      certIndex: "0",
      title: "Infrastructure Improvement Proposal",
      description:
        "This proposal aims to improve the network infrastructure by upgrading critical components and enhancing scalability.",
      rationale:
        "Current infrastructure requires upgrades to handle increased network load and ensure long-term sustainability.",
      governanceActionType: GovernanceType.TREASURY_WITHDRAWALS,
      status: ProposalStatus.ACTIVE,
      submissionEpoch: 450,
      expirationEpoch: 500,
      metadata: JSON.stringify({
        author: "Infrastructure Committee",
        budget: "500000 ADA",
        timeline: "6 months",
      }),
    },
  });

  const proposal2 = await prisma.proposal.create({
    data: {
      proposalId:
        "gov_action1abc456def789ghi012jkl345mno678pqr901stu234vwx567yz",
      txHash:
        "2a3b4c5d6e7f8g9h0i1j2k3l4m5n6o7p8q9r0s1t2u3v4w5x6y7z8a9b0c",
      certIndex: "1",
      title: "Constitutional Amendment Proposal",
      description:
        "Propose amendments to the Cardano constitution to clarify governance procedures and voting thresholds.",
      rationale:
        "Recent governance challenges have highlighted the need for clearer constitutional language.",
      governanceActionType: GovernanceType.NEW_CONSTITUTION,
      status: ProposalStatus.ACTIVE,
      submissionEpoch: 455,
      expirationEpoch: 505,
      metadata: JSON.stringify({
        author: "Constitutional Committee",
        sections_affected: ["Article 3", "Article 7"],
      }),
    },
  });

  const proposal3 = await prisma.proposal.create({
    data: {
      proposalId:
        "gov_action1xyz999uuu888ttt777sss666rrr555qqq444ppp333ooo222",
      txHash:
        "3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e",
      certIndex: "0",
      title: "Protocol Parameter Update",
      description:
        "Update protocol parameters to optimize network performance and fee structure.",
      rationale: "Network analysis shows opportunities for optimization.",
      governanceActionType: GovernanceType.PROTOCOL_PARAMETER_CHANGE,
      status: ProposalStatus.RATIFIED,
      submissionEpoch: 430,
      expirationEpoch: 480,
    },
  });

  const proposal4 = await prisma.proposal.create({
    data: {
      proposalId:
        "gov_action1info111test222demo333mock444data555seed666db",
      txHash:
        "4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f",
      certIndex: "2",
      title: "Community Outreach Program",
      description:
        "Information action to promote community engagement and education initiatives.",
      governanceActionType: GovernanceType.INFO_ACTION,
      status: ProposalStatus.EXPIRED,
      submissionEpoch: 400,
      expirationEpoch: 450,
    },
  });

  // Create Onchain Votes
  console.log("✅ Creating onchain votes...");

  // Votes for Proposal 1
  await prisma.onchainVote.create({
    data: {
      id: "seed-drep1-prop1",
      txHash: "vote_tx_hash_drep1_prop1_abc123def456ghi789jkl012mno345",
      proposalId: proposal1.proposalId,
      vote: VoteType.YES,
      voterType: VoterType.DREP,
      drepId: drep1.drepId,
      votingPower: BigInt("1500000000000"), // 1.5M ADA
      anchorUrl: "https://example.com/vote-metadata/drep1-prop1",
      anchorHash: "abc123def456",
    },
  });

  await prisma.onchainVote.create({
    data: {
      id: "seed-drep2-prop1",
      txHash: "vote_tx_hash_drep2_prop1_def789ghi012jkl345mno678pqr901",
      proposalId: proposal1.proposalId,
      vote: VoteType.YES,
      voterType: VoterType.DREP,
      drepId: drep2.drepId,
      votingPower: BigInt("3200000000000"), // 3.2M ADA
      anchorUrl: "https://example.com/vote-metadata/drep2-prop1",
      anchorHash: "def789ghi012",
    },
  });

  await prisma.onchainVote.create({
    data: {
      id: "seed-spo1-prop1",
      txHash: "vote_tx_hash_spo1_prop1_ghi012jkl345mno678pqr901stu234",
      proposalId: proposal1.proposalId,
      vote: VoteType.YES,
      voterType: VoterType.SPO,
      spoId: spo1.poolId,
      votingPower: BigInt("10000000000000"), // 10M ADA
    },
  });

  await prisma.onchainVote.create({
    data: {
      id: "seed-spo2-prop1",
      txHash: "vote_tx_hash_spo2_prop1_jkl345mno678pqr901stu234vwx567",
      proposalId: proposal1.proposalId,
      vote: VoteType.ABSTAIN,
      voterType: VoterType.SPO,
      spoId: spo2.poolId,
      votingPower: BigInt("8500000000000"), // 8.5M ADA
    },
  });

  await prisma.onchainVote.create({
    data: {
      id: "seed-cc1-prop1",
      txHash: "vote_tx_hash_cc1_prop1_mno678pqr901stu234vwx567yz890a",
      proposalId: proposal1.proposalId,
      vote: VoteType.YES,
      voterType: VoterType.CC,
      ccId: cc1.ccId,
      votingPower: BigInt(1),
    },
  });

  await prisma.onchainVote.create({
    data: {
      id: "seed-cc2-prop1",
      txHash: "vote_tx_hash_cc2_prop1_pqr901stu234vwx567yz890abc123",
      proposalId: proposal1.proposalId,
      vote: VoteType.YES,
      voterType: VoterType.CC,
      ccId: cc2.ccId,
      votingPower: BigInt(1),
    },
  });

  // Votes for Proposal 2
  await prisma.onchainVote.create({
    data: {
      id: "seed-drep1-prop2",
      txHash: "vote_tx_hash_drep1_prop2_stu234vwx567yz890abc123def456",
      proposalId: proposal2.proposalId,
      vote: VoteType.NO,
      voterType: VoterType.DREP,
      drepId: drep1.drepId,
      votingPower: BigInt("1500000000000"), // 1.5M ADA
    },
  });

  await prisma.onchainVote.create({
    data: {
      id: "seed-drep2-prop2",
      txHash: "vote_tx_hash_drep2_prop2_vwx567yz890abc123def456ghi789",
      proposalId: proposal2.proposalId,
      vote: VoteType.YES,
      voterType: VoterType.DREP,
      drepId: drep2.drepId,
      votingPower: BigInt("3200000000000"), // 3.2M ADA
    },
  });

  await prisma.onchainVote.create({
    data: {
      id: "seed-cc1-prop2",
      txHash: "vote_tx_hash_cc1_prop2_yz890abc123def456ghi789jkl012m",
      proposalId: proposal2.proposalId,
      vote: VoteType.ABSTAIN,
      voterType: VoterType.CC,
      ccId: cc1.ccId,
      votingPower: BigInt(1),
    },
  });

  // Votes for Proposal 3
  await prisma.onchainVote.create({
    data: {
      id: "seed-spo1-prop3",
      txHash: "vote_tx_hash_spo1_prop3_abc123def456ghi789jkl012mno345",
      proposalId: proposal3.proposalId,
      vote: VoteType.YES,
      voterType: VoterType.SPO,
      spoId: spo1.poolId,
      votingPower: BigInt("10000000000000"), // 10M ADA
    },
  });

  await prisma.onchainVote.create({
    data: {
      id: "seed-spo2-prop3",
      txHash: "vote_tx_hash_spo2_prop3_def456ghi789jkl012mno345pqr678",
      proposalId: proposal3.proposalId,
      vote: VoteType.YES,
      voterType: VoterType.SPO,
      spoId: spo2.poolId,
      votingPower: BigInt("8500000000000"), // 8.5M ADA
    },
  });

  // Create Proposal Drafts
  console.log("📝 Creating proposal drafts...");
  const draft1 = await prisma.proposalDraft.create({
    data: {
      governanceActionType: GovernanceType.TREASURY_WITHDRAWALS,
      title: "Community Development Fund",
      abstract:
        "Establish a fund to support community-led development initiatives.",
      motivation: "Enable grassroots innovation and community empowerment.",
      rationale:
        "Decentralized development leads to more diverse and resilient ecosystem.",
      comment: "Initial draft, seeking community feedback.",
      references: "https://forum.cardano.org/community-fund-discussion",
      metadata: JSON.stringify({
        version: "1.0",
        author: "Community Dev Team",
      }),
    },
  });

  const draft2 = await prisma.proposalDraft.create({
    data: {
      governanceActionType: GovernanceType.INFO_ACTION,
      title: "Educational Initiative",
      abstract: "Launch educational programs to onboard new developers.",
      motivation:
        "Growing the developer community is essential for ecosystem growth.",
      rationale: "More developers means more innovation and applications.",
      metadata: JSON.stringify({
        version: "1.0",
        author: "Education Committee",
      }),
    },
  });

  // Create Crowdfunding Campaigns
  console.log("💰 Creating crowdfunding campaigns...");
  await prisma.crowdfundingCampaign.create({
    data: {
      proposalDraftId: draft1.id,
    },
  });

  console.log("✅ Database seeded successfully!");
  console.log(`
📊 Summary:
  - ${await prisma.user.count()} Users
  - ${await prisma.drep.count()} DReps
  - ${await prisma.sPO.count()} SPOs
  - ${await prisma.cC.count()} CC Members
  - ${await prisma.proposal.count()} Proposals (including expired: ${
    proposal4.title
  })
  - ${await prisma.onchainVote.count()} Onchain Votes
  - ${await prisma.proposalDraft.count()} Proposal Drafts (${draft2.title})
  - ${await prisma.crowdfundingCampaign.count()} Crowdfunding Campaigns
  `);
}

main()
  .catch((e) => {
    console.error("❌ Error seeding database:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
