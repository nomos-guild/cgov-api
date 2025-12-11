/**
 * Cron Service Entry Point
 * Runs only the cron jobs without starting the API server
 */

import dotenv from "dotenv";
import { startAllJobs } from "./jobs";

dotenv.config();

console.log("Starting CGOV Cron Service...");

// Start all cron jobs
startAllJobs();

console.log("✅ CGOV Cron Service is running");

// Keep the process alive
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});