---
name: add-endpoint
version: 1.2.0
created: 2026-02-04
last-evolved: 2026-02-04
evolution-count: 2
feedback-count: 0
description: Scaffold a new Express API endpoint with controller, route (OpenAPI annotations), response type, and barrel exports.
argument-hint: [domain] [method] [path] [description]
allowed-tools: Read, Edit, Write, Glob, Grep
---

# Add API Endpoint

Scaffold a complete Express.js API endpoint following the project's established patterns: controller, route with @openapi annotations, response type, and barrel exports.

## Arguments

- `$0` - Domain/feature area (e.g., `drep`, `overview`, `proposal`, or a new domain like `spo`)
- `$1` - HTTP method: `get` or `post` (default: `get`)
- `$2` - URL path suffix (e.g., `stats`, `:id/votes`, `trigger-cleanup`)
- `$3` - Short description of the endpoint (e.g., "Get aggregate SPO statistics")

## Instructions

### Step 1: Check if domain exists

Look for existing files:

```
src/controllers/{$0}/index.ts
src/routes/{$0}.route.ts
```

If the domain is **new**, you'll also need Steps 6 and 7. If it **exists**, skip those steps.

### Step 2: Create the controller

Create `src/controllers/{$0}/{handlerName}.ts`:

```typescript
import { Request, Response } from "express";
import { prisma } from "../../services";

/**
 * {$1 uppercase} /{$0}/{$2}
 * {$3}
 */
export const {handlerName} = async (req: Request, res: Response) => {
  try {
    // TODO: Implement endpoint logic
    const data = {};

    res.json(data);
  } catch (error) {
    console.error("Error in {handlerName}", error);
    res.status(500).json({
      error: "Failed to {$3 lowercase}",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
```

**Handler naming conventions:**
- GET endpoints: `get{Resource}` (e.g., `getSPOStats`, `getDRepVotes`)
- POST endpoints: `post{Action}` (e.g., `postTriggerSync`, `postIngestProposal`)

**For paginated endpoints**, add this query param parsing at the top:

```typescript
const page = Math.max(1, parseInt(req.query.page as string) || 1);
const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
const skip = (page - 1) * pageSize;
```

**For BigInt fields**, always convert before JSON response:

```typescript
// BigInt → string for serialization
const votingPowerStr = drep.votingPower.toString();

// BigInt → ADA string
function lovelaceToAda(lovelace: bigint): string {
  return (Number(lovelace) / 1_000_000).toFixed(6);
}
```

### Step 3: Export from controller barrel

Add to `src/controllers/{$0}/index.ts`:

```typescript
export * from "./{handlerFileName}";
```

### Step 4: Add route with OpenAPI annotation

Add to `src/routes/{$0}.route.ts`:

```typescript
/**
 * @openapi
 * /{$0}/{$2}:
 *   {$1}:
 *     summary: {$3}
 *     description: {Longer description}
 *     tags:
 *       - {Domain Tag}
 *     parameters:
 *       - name: paramName
 *         in: path|query
 *         required: true|false
 *         description: Parameter description
 *         schema:
 *           type: string|integer
 *     responses:
 *       200:
 *         description: Success description
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/{ResponseType}'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.{$1}("/{$2}", {$0}Controller.{handlerName});
```

### Step 5: Define response type

Add to `src/responses/{$0}.response.ts` (create if new domain):

```typescript
/**
 * Response type for {$3}
 */
export interface {ResponseTypeName} {
  // Define fields here
}
```

Then export from `src/responses/index.ts`:

```typescript
export * from "./{$0}.response";
```

### Step 6: (New domain only) Create route file

Create `src/routes/{$0}.route.ts`:

```typescript
import express from "express";
import { {$0}Controller } from "../controllers";

const router = express.Router();

// ... routes go here ...

export default router;
```

### Step 7: (New domain only) Mount in app

Add to `src/index.ts`:

```typescript
import {$0}Router from "./routes/{$0}.route";

// In the middleware section:
app.use("/{$0}", apiKeyAuth, {$0}Router);
```

And add the controller barrel export to `src/controllers/index.ts`:

```typescript
export * as {$0}Controller from "./{$0}";
```

## Checklist

- [ ] Controller created with try/catch error handling
- [ ] Controller exported from domain barrel (`index.ts`)
- [ ] Route added with `@openapi` JSDoc annotation
- [ ] Response type defined and exported from `src/responses/`
- [ ] BigInt fields serialized to strings (not raw BigInt in JSON)
- [ ] Paginated endpoints include `{ page, pageSize, totalItems, totalPages }`
- [ ] If new domain: route file created, mounted in `src/index.ts`, controller barrel exported

## Common Patterns

### Vote/relation count aggregation

When an endpoint needs counts from a related model (e.g., vote count per DRep), Prisma doesn't support filtered `_count` in `findMany`. Use `groupBy` + in-memory join:

```typescript
// 1. Fetch main entities
const dreps = await prisma.drep.findMany({ ... });
const drepIds = dreps.map((d) => d.drepId);

// 2. Fetch counts via groupBy
const voteCounts = await prisma.onchainVote.groupBy({
  by: ["drepId"],
  where: { drepId: { in: drepIds }, voterType: VoterType.DREP },
  _count: { id: true },
});

// 3. Join in memory
const voteCountMap = new Map<string, number>();
for (const vc of voteCounts) {
  if (vc.drepId) voteCountMap.set(vc.drepId, vc._count.id);
}

// 4. Use in response mapping
const summaries = dreps.map((d) => ({
  ...d,
  totalVotesCast: voteCountMap.get(d.drepId) || 0,
}));
```

### doNotList filtering

DReps with `doNotList: true` should be excluded. Since the field is nullable, always use:

```typescript
const whereClause = {
  OR: [{ doNotList: false }, { doNotList: null }],
};
```

### In-memory sorting for computed fields

When sorting by a field not in the DB (e.g., `totalVotes`):

```typescript
if (sortBy === "totalVotes") {
  results.sort((a, b) => {
    const diff = a.totalVotesCast - b.totalVotesCast;
    return sortOrder === "asc" ? diff : -diff;
  });
}
```

Note: pagination still works correctly for DB-column sorts (votingPower, name) but for computed-field sorts the page boundary may shift.

### Aggregate stats with _sum

```typescript
const aggregateResult = await prisma.drep.aggregate({
  where: { OR: [{ doNotList: false }, { doNotList: null }] },
  _sum: { votingPower: true, delegatorCount: true },
});
const total = aggregateResult._sum.votingPower ?? BigInt(0);
```

### BigInt percentage calculations

When computing percentages with BigInt (e.g., vote power ratios), use scaled arithmetic to preserve precision:

```typescript
// Multiply by 10000 first (for 2 decimal places), then divide
const turnoutPct = totalPower > 0n
  ? Number((activePower * 10000n) / totalPower) / 100
  : null;
```

### Latest vote per voter (deduplication)

For voters who can change their vote (e.g., CC members), always order by timestamp and dedupe:

```typescript
const votes = await prisma.onchainVote.findMany({
  where: { voterType: VoterType.CC },
  orderBy: [{ votedAt: "desc" }, { createdAt: "desc" }],
});

const seenVotes = new Set<string>();
for (const vote of votes) {
  const key = `${vote.ccId}-${vote.proposalId}`;
  if (!seenVotes.has(key)) {
    seenVotes.add(key);
    // Process this vote (it's the latest)
  }
}
```

### Epoch time mapping

For wall-clock calculations from epoch numbers, build a lookup map:

```typescript
const epochTimestamps = await prisma.epochTotals.findMany({
  where: { epoch: { in: Array.from(epochs) } },
  select: { epoch: true, startTime: true, endTime: true },
});

const epochTimeMap = new Map<number, Date>();
for (const et of epochTimestamps) {
  if (et.startTime && et.endTime) {
    const midpoint = new Date((et.startTime.getTime() + et.endTime.getTime()) / 2);
    epochTimeMap.set(et.epoch, midpoint);
  }
}
```

### Analytics metrics

**Gini coefficient** for decentralization (0 = equal, 1 = concentrated):

```typescript
// Sort values ascending, compute weighted sum
const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
let sum = 0n, weightedSum = 0n;
for (let i = 0; i < sorted.length; i++) {
  sum += sorted[i];
  weightedSum += BigInt(i + 1) * sorted[i];
}
const gini = Number((2n * weightedSum - BigInt(n + 1) * sum) * 10000n / (BigInt(n) * sum)) / 10000;
```

**HHI (Herfindahl-Hirschman Index)** for concentration (0-10000):

```typescript
let hhi = 0;
for (const [, data] of groupPower) {
  const sharePct = Number((data.power * 10000n) / totalPower) / 100;
  hhi += sharePct * sharePct;
}
```

**Contention score** (0-100, higher = more contentious):

```typescript
const diff = Math.abs(yesPct - noPct);
const contentionScore = 100 - diff; // 50/50 = 100, 100/0 = 0
const isContentious = diff < 20; // Within 40-60 range
```

## After Creation

1. Run `npm run build` to verify TypeScript compiles
2. Run `npm run swagger:generate` to update API docs
3. Test with `curl http://localhost:3000/{$0}/{$2}`
