---
name: add-endpoint
version: 1.0.0
created: 2026-02-04
last-evolved: 2026-02-04
evolution-count: 0
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

## After Creation

1. Run `npm run build` to verify TypeScript compiles
2. Run `npm run swagger:generate` to update API docs
3. Test with `curl http://localhost:3000/{$0}/{$2}`
