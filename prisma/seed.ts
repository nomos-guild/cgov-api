import {
  PrismaClient,
  vote_type,
  voter_type,
  governance_type,
  proposal_status,
} from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting database seed...");

  // Clean existing data (optional - comment out if you want to keep existing data)
  console.log("🧹 Cleaning existing data...");
  await prisma.onchain_vote.deleteMany({});
  await prisma.proposal.deleteMany({});
  await prisma.drep.deleteMany({});
  await prisma.spo.deleteMany({});
  await prisma.cc.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.crowdfunding_campaign.deleteMany({});
  await prisma.proposal_draft.deleteMany({});

  // Create Users
  console.log("👤 Creating users...");
  const user1 = await prisma.user.create({
    data: {
      id: "user-1",
      wallet_address:
        "addr1qxy3w6z5abc123def456ghi789jkl012mno345pqr678stu901vwx234yz",
      stake_key_lovelace: 1_000_000,
      jwt: "mock-jwt-token-user1",
    },
  });

  const user2 = await prisma.user.create({
    data: {
      id: "user-2",
      wallet_address:
        "addr1qab2cd3ef4gh5ij6kl7mn8op9qr0st1uv2wx3yz4ab5cd6ef",
      stake_key_lovelace: 2_500_000,
      jwt: "mock-jwt-token-user2",
    },
  });

  const user3 = await prisma.user.create({
    data: {
      id: "user-3",
      wallet_address:
        "addr1qzz9yy8xx7ww6vv5uu4tt3ss2rr1qq0pp9oo8nn7mm6ll5kk",
      stake_key_lovelace: 5_000_000,
      jwt: "mock-jwt-token-user3",
    },
  });

  // Create DReps
  console.log("🗳️  Creating DReps...");
  const drep1 = await prisma.drep.create({
    data: {
      drep_id: "drep1abc123def456ghi789jkl012mno345pqr678stu901vwx234yz",
      user_id: user1.id,
      payment_addr: "stake1abc123def456",
      voting_power: BigInt(1_500_000),
      name: "Seed DRep 1",
    },
  });

  const drep2 = await prisma.drep.create({
    data: {
      drep_id: "drep1xyz789uvw456rst123opq890lmn567ijk345fgh012cde678",
      payment_addr: "stake1xyz789uvw456",
      voting_power: BigInt(3_200_000),
      name: "Seed DRep 2",
    },
  });

  // Create SPOs
  console.log("🏊 Creating SPOs...");
  const spo1 = await prisma.spo.create({
    data: {
      pool_id:
        "pool1qwertyuiopasdfghjklzxcvbnm1234567890abcdefghijklmno",
      user_id: user2.id,
      pool_name: "Cardano Stake Pool Alpha",
      ticker: "ALPHA",
      voting_power: BigInt(10_000_000),
    },
  });

  const spo2 = await prisma.spo.create({
    data: {
      pool_id:
        "pool1mnbvcxzlkjhgfdsapoiuytrewq0987654321zyxwvutsrqpo",
      pool_name: "Beta Pool",
      ticker: "BETA",
      voting_power: BigInt(8_500_000),
    },
  });

  // Create CC Members
  console.log("🏛️  Creating Constitutional Committee members...");
  const cc1 = await prisma.cc.create({
    data: {
      cc_id: "cc1_abc123def456ghi789jkl012mno345pqr678",
      user_id: user3.id,
      member_name: "Alice Johnson",
      hot_credential: "hot_cred_alice123",
      cold_credential: "cold_cred_alice456",
      status: "Active",
    },
  });

  const cc2 = await prisma.cc.create({
    data: {
      cc_id: "cc1_xyz789uvw456rst123opq890lmn567ijk",
      member_name: "Bob Smith",
      hot_credential: "hot_cred_bob789",
      cold_credential: "cold_cred_bob012",
      status: "Active",
    },
  });

  // Create Proposals
  console.log("📋 Creating proposals...");
  const proposal1 = await prisma.proposal.create({
    data: {
      proposal_id:
        "gov_action1zhuz5djmmmjg8f9s8pe6grfc98xg3szglums8cgm6qwancp4eytqqmpu0pr",
      tx_hash:
        "15f82a365bdee483a4b03873a40d3829cc88c048ff3703e11bd01dd9e035c916",
      cert_index: "0",
      title: "Infrastructure Improvement Proposal",
      description:
        "This proposal aims to improve the network infrastructure by upgrading critical components and enhancing scalability.",
      rationale:
        "Current infrastructure requires upgrades to handle increased network load and ensure long-term sustainability.",
      governance_action_type: governance_type.TREASURY_WITHDRAWALS,
      status: proposal_status.ACTIVE,
      submission_epoch: 450,
      expiration_epoch: 500,
      metadata: JSON.stringify({
        author: "Infrastructure Committee",
        budget: "500000 ADA",
        timeline: "6 months",
      }),
    },
  });

  const proposal2 = await prisma.proposal.create({
    data: {
      proposal_id:
        "gov_action1abc456def789ghi012jkl345mno678pqr901stu234vwx567yz",
      tx_hash:
        "2a3b4c5d6e7f8g9h0i1j2k3l4m5n6o7p8q9r0s1t2u3v4w5x6y7z8a9b0c",
      cert_index: "1",
      title: "Constitutional Amendment Proposal",
      description:
        "Propose amendments to the Cardano constitution to clarify governance procedures and voting thresholds.",
      rationale:
        "Recent governance challenges have highlighted the need for clearer constitutional language.",
      governance_action_type: governance_type.NEW_CONSTITUTION,
      status: proposal_status.ACTIVE,
      submission_epoch: 455,
      expiration_epoch: 505,
      metadata: JSON.stringify({
        author: "Constitutional Committee",
        sections_affected: ["Article 3", "Article 7"],
      }),
    },
  });

  const proposal3 = await prisma.proposal.create({
    data: {
      proposal_id:
        "gov_action1xyz999uuu888ttt777sss666rrr555qqq444ppp333ooo222",
      tx_hash:
        "3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e",
      cert_index: "0",
      title: "Protocol Parameter Update",
      description:
        "Update protocol parameters to optimize network performance and fee structure.",
      rationale: "Network analysis shows opportunities for optimization.",
      governance_action_type: governance_type.PROTOCOL_PARAMETER_CHANGE,
      status: proposal_status.RATIFIED,
      submission_epoch: 430,
      expiration_epoch: 480,
    },
  });

  const proposal4 = await prisma.proposal.create({
    data: {
      proposal_id:
        "gov_action1info111test222demo333mock444data555seed666db",
      tx_hash:
        "4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f",
      cert_index: "2",
      title: "Community Outreach Program",
      description:
        "Information action to promote community engagement and education initiatives.",
      governance_action_type: governance_type.INFO_ACTION,
      status: proposal_status.EXPIRED,
      submission_epoch: 400,
      expiration_epoch: 450,
    },
  });

  // Create Onchain Votes
  console.log("✅ Creating onchain votes...");

  // Votes for Proposal 1
  await prisma.onchain_vote.create({
    data: {
      id: "seed-drep1-prop1",
      tx_hash: "vote_tx_hash_drep1_prop1_abc123def456ghi789jkl012mno345",
      proposal_id: proposal1.proposal_id,
      vote: vote_type.YES,
      voter_type: voter_type.DREP,
      drep_id: drep1.drep_id,
      voting_power: BigInt("1500000000000"), // 1.5M ADA
      anchor_url: "https://example.com/vote-metadata/drep1-prop1",
      anchor_hash: "abc123def456",
    },
  });

  await prisma.onchain_vote.create({
    data: {
      id: "seed-drep2-prop1",
      tx_hash: "vote_tx_hash_drep2_prop1_def789ghi012jkl345mno678pqr901",
      proposal_id: proposal1.proposal_id,
      vote: vote_type.YES,
      voter_type: voter_type.DREP,
      drep_id: drep2.drep_id,
      voting_power: BigInt("3200000000000"), // 3.2M ADA
      anchor_url: "https://example.com/vote-metadata/drep2-prop1",
      anchor_hash: "def789ghi012",
    },
  });

  await prisma.onchain_vote.create({
    data: {
      id: "seed-spo1-prop1",
      tx_hash: "vote_tx_hash_spo1_prop1_ghi012jkl345mno678pqr901stu234",
      proposal_id: proposal1.proposal_id,
      vote: vote_type.YES,
      voter_type: voter_type.SPO,
      spo_id: spo1.pool_id,
      voting_power: BigInt("10000000000000"), // 10M ADA
    },
  });

  await prisma.onchain_vote.create({
    data: {
      id: "seed-spo2-prop1",
      tx_hash: "vote_tx_hash_spo2_prop1_jkl345mno678pqr901stu234vwx567",
      proposal_id: proposal1.proposal_id,
      vote: vote_type.ABSTAIN,
      voter_type: voter_type.SPO,
      spo_id: spo2.pool_id,
      voting_power: BigInt("8500000000000"), // 8.5M ADA
    },
  });

  await prisma.onchain_vote.create({
    data: {
      id: "seed-cc1-prop1",
      tx_hash: "vote_tx_hash_cc1_prop1_mno678pqr901stu234vwx567yz890a",
      proposal_id: proposal1.proposal_id,
      vote: vote_type.YES,
      voter_type: voter_type.CC,
      cc_id: cc1.cc_id,
      voting_power: BigInt(1),
    },
  });

  await prisma.onchain_vote.create({
    data: {
      id: "seed-cc2-prop1",
      tx_hash: "vote_tx_hash_cc2_prop1_pqr901stu234vwx567yz890abc123",
      proposal_id: proposal1.proposal_id,
      vote: vote_type.YES,
      voter_type: voter_type.CC,
      cc_id: cc2.cc_id,
      voting_power: BigInt(1),
    },
  });

  // Votes for Proposal 2
  await prisma.onchain_vote.create({
    data: {
      id: "seed-drep1-prop2",
      tx_hash: "vote_tx_hash_drep1_prop2_stu234vwx567yz890abc123def456",
      proposal_id: proposal2.proposal_id,
      vote: vote_type.NO,
      voter_type: voter_type.DREP,
      drep_id: drep1.drep_id,
      voting_power: BigInt("1500000000000"), // 1.5M ADA
    },
  });

  await prisma.onchain_vote.create({
    data: {
      id: "seed-drep2-prop2",
      tx_hash: "vote_tx_hash_drep2_prop2_vwx567yz890abc123def456ghi789",
      proposal_id: proposal2.proposal_id,
      vote: vote_type.YES,
      voter_type: voter_type.DREP,
      drep_id: drep2.drep_id,
      voting_power: BigInt("3200000000000"), // 3.2M ADA
    },
  });

  await prisma.onchain_vote.create({
    data: {
      id: "seed-cc1-prop2",
      tx_hash: "vote_tx_hash_cc1_prop2_yz890abc123def456ghi789jkl012m",
      proposal_id: proposal2.proposal_id,
      vote: vote_type.ABSTAIN,
      voter_type: voter_type.CC,
      cc_id: cc1.cc_id,
      voting_power: BigInt(1),
    },
  });

  // Votes for Proposal 3
  await prisma.onchain_vote.create({
    data: {
      id: "seed-spo1-prop3",
      tx_hash: "vote_tx_hash_spo1_prop3_abc123def456ghi789jkl012mno345",
      proposal_id: proposal3.proposal_id,
      vote: vote_type.YES,
      voter_type: voter_type.SPO,
      spo_id: spo1.pool_id,
      voting_power: BigInt("10000000000000"), // 10M ADA
    },
  });

  await prisma.onchain_vote.create({
    data: {
      id: "seed-spo2-prop3",
      tx_hash: "vote_tx_hash_spo2_prop3_def456ghi789jkl012mno345pqr678",
      proposal_id: proposal3.proposal_id,
      vote: vote_type.YES,
      voter_type: voter_type.SPO,
      spo_id: spo2.pool_id,
      voting_power: BigInt("8500000000000"), // 8.5M ADA
    },
  });

  // Create Proposal Drafts
  console.log("📝 Creating proposal drafts...");
  const draft1 = await prisma.proposal_draft.create({
    data: {
      governance_action_type: governance_type.TREASURY_WITHDRAWALS,
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

  const draft2 = await prisma.proposal_draft.create({
    data: {
      governance_action_type: governance_type.INFO_ACTION,
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
  await prisma.crowdfunding_campaign.create({
    data: {
      proposal_draft_id: draft1.id,
    },
  });

  console.log("✅ Database seeded successfully!");
  console.log(`
📊 Summary:
  - ${await prisma.user.count()} Users
  - ${await prisma.drep.count()} DReps
  - ${await prisma.spo.count()} SPOs
  - ${await prisma.cc.count()} CC Members
  - ${await prisma.proposal.count()} Proposals (including expired: ${
    proposal4.title
  })
  - ${await prisma.onchain_vote.count()} Onchain Votes
  - ${await prisma.proposal_draft.count()} Proposal Drafts (${draft2.title})
  - ${await prisma.crowdfunding_campaign.count()} Crowdfunding Campaigns
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
