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

### POST /data/vote/:tx_hash

### POST /data/drep/:drep_id

### POST /data/cc/:cc_id

### POST /data/spo/:spo_id

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
