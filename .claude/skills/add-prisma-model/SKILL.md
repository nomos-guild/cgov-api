---
name: add-prisma-model
version: 1.0.0
created: 2026-02-04
last-evolved: 2026-02-04
evolution-count: 0
feedback-count: 0
description: Scaffold a new Prisma database model with project conventions (snake_case mapping, BigInt for lovelace, timestamps, relations).
argument-hint: [ModelName] [description]
allowed-tools: Read, Edit, Write, Bash, Glob
---

# Add Prisma Model

Scaffold a new Prisma model following the project's established conventions for the PostgreSQL database.

## Arguments

- `$0` - PascalCase model name (e.g., `Delegation`, `EpochSnapshot`)
- `$1` - Short description of the model (e.g., "DRep delegation records")

## Instructions

### Step 1: Read the current schema

Read `prisma/schema.prisma` to understand:
- Existing models and their patterns
- Available enums
- Relation patterns in use

### Step 2: Add the model to schema

Add to `prisma/schema.prisma` following these conventions:

```prisma
/// {$1}
model {$0} {
  // Primary key - use string for Cardano identifiers, Int for internal IDs
  id          String    @id @map("id")
  // OR for auto-increment:
  // id       Int       @id @default(autoincrement())

  // Fields - camelCase in Prisma, snake_case in DB via @map
  fieldName   String    @map("field_name")

  // Optional fields
  optionalField String? @map("optional_field")

  // Monetary/voting power values - ALWAYS use BigInt
  amount      BigInt    @default(0) @map("amount")

  // Enums - reference existing Prisma enums
  status      ProposalStatus @default(ACTIVE)

  // Timestamps - standard pattern
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  // Relations
  proposal    Proposal  @relation(fields: [proposalId], references: [id])
  proposalId  String    @map("proposal_id")

  // Table name mapping - ALWAYS snake_case
  @@map("{snake_case_table_name}")

  // Unique constraints (if any)
  @@unique([field1, field2])
}
```

### Conventions Reference

| Convention | Rule | Example |
|-----------|------|---------|
| Model name | PascalCase | `EpochSnapshot` |
| Field names | camelCase in Prisma | `votingPower` |
| DB columns | snake_case via `@map` | `@map("voting_power")` |
| Table name | snake_case via `@@map` | `@@map("epoch_snapshot")` |
| Monetary values | Always `BigInt` | `amount BigInt @default(0)` |
| Cardano IDs | `String @id` | `drepId String @id @map("drep_id")` |
| Internal IDs | `Int @id @default(autoincrement())` | `id Int @id @default(autoincrement())` |
| String IDs | `String @id` or `String @id @default(uuid())` | For custom or UUID keys |
| Timestamps | `createdAt` + `updatedAt` | See pattern above |
| Optional `createdAt` | `DateTime? @default(now())` | Some older models use this |
| Required `updatedAt` | `DateTime @updatedAt` | Auto-updated by Prisma |

### Field Type Guide

| Data Type | Prisma Type | Notes |
|-----------|-------------|-------|
| Lovelace/ADA amounts | `BigInt` | Always, even if values seem small |
| Voting power | `BigInt` | Lovelace values |
| Cardano address/hash | `String` | 64-char hex or bech32 |
| Epoch numbers | `Int` | Standard integer |
| Counts | `Int` | delegatorCount, voteCount |
| Boolean flags | `Boolean` | With `@default(false)` |
| JSON metadata | `String` | Store as string, parse in code |
| Timestamps | `DateTime` | With `@default(now())` or `@updatedAt` |

### Step 3: Add relations (if needed)

If the new model relates to existing models, update both sides:

```prisma
// In existing model (e.g., Proposal):
myNewModels  {$0}[]

// In new model:
proposal     Proposal @relation(fields: [proposalId], references: [id])
proposalId   String   @map("proposal_id")
```

### Step 4: Run migration

```bash
# Create migration (will prompt for migration name)
npx prisma migrate dev --name add_{snake_case_model_name}

# Generate updated Prisma client types
npx prisma generate
```

### Step 5: Verify build

```bash
npm run build
```

This ensures all TypeScript types from Prisma are correct and existing code still compiles.

### Step 6: Create response type (if model will be exposed via API)

Add to `src/responses/{domain}.response.ts`:

```typescript
export interface {$0}Response {
  // Mirror model fields but:
  // - BigInt → string (for JSON serialization)
  // - Add computed fields (e.g., votingPowerAda)
  // - Omit internal fields (userId, etc.)
}
```

## Gotchas

- **BigInt serialization**: Prisma returns `BigInt` but `JSON.stringify` throws on `BigInt`. Always `.toString()` before sending in response.
- **Migration naming**: Use `snake_case` descriptive names like `add_epoch_snapshot`, `add_delegation_tracking`.
- **Existing data**: If adding required fields to existing models, provide a `@default` or make them optional (`?`).
- **Unique constraints**: Add `@@unique` for fields that should be upsert keys (common for Cardano data ingestion).
- **Index hints**: Add `@@index([field])` for fields frequently used in WHERE clauses or JOINs.

## Checklist

- [ ] Model added to `prisma/schema.prisma`
- [ ] All field names use `@map("snake_case")` for DB columns
- [ ] Table uses `@@map("snake_case")` for DB table name
- [ ] Monetary/lovelace values use `BigInt` type
- [ ] Timestamps follow `createdAt`/`updatedAt` pattern
- [ ] Relations added on both sides (if applicable)
- [ ] Migration created and applied (`npx prisma migrate dev`)
- [ ] Prisma client regenerated (`npx prisma generate`)
- [ ] Build passes (`npm run build`)
- [ ] Response type created (if API-exposed)
