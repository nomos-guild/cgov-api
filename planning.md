# API Planning

## App

### POST /sign-in

## Overview - Santosh

### GET /overview

- Get governance action details

### GET /overview/proposals

- Get overview of all proposals

## Proposal - Santosh

### GET /proposal/:proposal_id

- Get details on a specific proposal

## Data

### POST /data/proposal/:proposal_hash

- Ingest into `Proposal` table

Use Koios API

Use Koios GET Proposals List (For most of the fields except for onchainVotes)

For onchainVotes, we need to use below APIs:

- Get Vote List
- Get DReps Info
- Get Pool Information
- Get Committee Information
- Get DReps Voting Power History
- Get Pool's Voting Power History

### POST /data/vote/:tx_hash

- Ingest into `OnchainVote` table

### POST /data/drep/:drep_id

- Ingest into `Drep` table

### POST /data/cc/:cc_id

- Ingest into `CC` table

### POST /data/spo/:spo_id

- Ingest into `SPO` table

## Cron Job

- Trigger ingestion of proposals
- For each new proposal
  - Ingest proposal `/data/proposal/:proposal_hash`
  - Get all voting records, for each:
    - Ingest vote `/data/vote/:tx_hash`
    - For the voter, if not exist in DB - ingest:
      - drep - `/data/drep/:drep_id`
      - cc - `/data/cc/:cc_id`
      - spo - `/data/spo/:spo_id`
