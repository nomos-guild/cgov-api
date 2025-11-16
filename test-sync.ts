/**
 * Manual test script for proposal sync
 * Run with: npx ts-node test-sync.ts
 */

import dotenv from "dotenv";
import { syncAllProposals } from "./src/services/ingestion/proposal.service";

// Load environment variables
dotenv.config();

async function testSync() {
  console.log("Starting manual proposal sync test...\n");

  try {
    const results = await syncAllProposals();

    console.log("\n✅ Sync completed successfully!");
    console.log("Results:", JSON.stringify(results, null, 2));

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Sync failed:");
    console.error(error);

    process.exit(1);
  }
}

testSync();