/**
 * Script to check what proposal_type values Koios returns
 */

import { koiosGet } from "./src/services/koios";
import type { KoiosProposal } from "./src/types/koios.types";

async function checkKoiosTypes() {
  console.log("Fetching proposals from Koios...\n");

  try {
    const allProposals = await koiosGet<KoiosProposal[]>("/proposal_list");

    console.log(`Total proposals from Koios: ${allProposals?.length || 0}\n`);

    if (!allProposals || allProposals.length === 0) {
      console.log("No proposals found");
      return;
    }

    // Count proposal types
    const typeCount = allProposals.reduce((acc, p) => {
      const type = p.proposal_type || 'undefined';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log("Proposal type distribution from Koios:");
    Object.entries(typeCount)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        console.log(`  "${type}": ${count}`);
      });

    // Show first few examples of each type
    console.log("\nFirst example of each type:");
    const seenTypes = new Set<string>();
    for (const p of allProposals) {
      const type = p.proposal_type || 'undefined';
      if (!seenTypes.has(type)) {
        console.log(`\n  Type: "${type}"`);
        console.log(`    Proposal ID: ${p.proposal_id}`);
        console.log(`    TX Hash: ${p.proposal_tx_hash}`);
        seenTypes.add(type);
      }
    }

    // Check if there are any proposals with IDs matching the missing ones
    console.log("\nChecking for specific proposals...");
    console.log(`First proposal: ${allProposals[0].proposal_id}`);
    console.log(`Last proposal: ${allProposals[allProposals.length - 1].proposal_id}`);

  } catch (error) {
    console.error("Error:", error);
  }
}

checkKoiosTypes();
