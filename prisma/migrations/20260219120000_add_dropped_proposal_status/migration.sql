-- Add explicit DROPPED terminal state for proposals dropped due to conflicts.
ALTER TYPE "proposal_status" ADD VALUE IF NOT EXISTS 'DROPPED';
