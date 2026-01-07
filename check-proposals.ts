/**
 * Script to check proposals in database
 */

import { prisma } from "./src/services";

async function checkProposals() {
  console.log("Checking proposals in database...\n");

  try {
    // Get all proposals ordered by ID
    const proposals = await prisma.proposal.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        proposalId: true,
        txHash: true,
        title: true,
        governanceActionType: true,
        status: true,
      },
    });

    console.log(`Total proposals in database: ${proposals.length}\n`);

    if (proposals.length > 0) {
      console.log("First 10 proposals:");
      proposals.slice(0, 10).forEach((p) => {
        console.log(`  ID: ${p.id}, proposalId: ${p.proposalId}, type: ${p.governanceActionType || 'null'}, status: ${p.status}`);
      });

      console.log("\nLast 10 proposals:");
      proposals.slice(-10).forEach((p) => {
        console.log(`  ID: ${p.id}, proposalId: ${p.proposalId}, type: ${p.governanceActionType || 'null'}, status: ${p.status}`);
      });

      // Check for gaps in IDs
      const ids = proposals.map(p => p.id).sort((a, b) => a - b);
      const minId = ids[0];
      const maxId = ids[ids.length - 1];

      console.log(`\nID range: ${minId} to ${maxId}`);

      const missingIds: number[] = [];
      for (let i = minId; i <= maxId; i++) {
        if (!ids.includes(i)) {
          missingIds.push(i);
        }
      }

      if (missingIds.length > 0) {
        console.log(`\nMissing IDs in sequence: ${missingIds.join(', ')}`);
      } else {
        console.log(`\nNo missing IDs in sequence`);
      }

      // Check governanceActionType distribution
      const typeCount = proposals.reduce((acc, p) => {
        const type = p.governanceActionType || 'null';
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log(`\nGovernance type distribution:`);
      Object.entries(typeCount).forEach(([type, count]) => {
        console.log(`  ${type}: ${count}`);
      });
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

checkProposals();
