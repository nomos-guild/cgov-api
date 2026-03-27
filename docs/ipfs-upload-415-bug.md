# IPFS Upload 415 Bug Analysis

**Date:** 2026-03-28
**Endpoint:** `POST /data/ipfs/upload`
**File:** `src/controllers/data/uploadToIpfs.ts`
**Symptom:** Blockfrost IPFS API returns HTTP 415 (Unsupported Media Type)

## Error

```json
{
  "error": "Failed to upload to IPFS",
  "message": "Request failed with status code 415"
}
```

The 415 originates from Blockfrost's IPFS API (`https://ipfs.blockfrost.io/api/v0/ipfs/add`), not from our backend validation.

## Root Cause

The controller uses native `FormData` and `Blob` to build a multipart upload, then sends it via `axios.post`:

```typescript
const blob = new Blob([JSON.stringify(json)], { type: "application/json" });
const formData = new FormData();
formData.append("file", blob, "metadata.jsonld");

const addResponse = await axios.post(
  "https://ipfs.blockfrost.io/api/v0/ipfs/add",
  formData,
  { headers: { project_id: projectId } }
);
```

**The problem:** Axios does not automatically set the `Content-Type: multipart/form-data` header with the correct boundary when receiving a native `FormData` object in Node.js. Without the boundary, Blockfrost cannot parse the multipart body and returns 415.

This differs from browser environments where `XMLHttpRequest` / `fetch` auto-set the boundary for `FormData`.

## Environment

- **Production Node.js:** 20 (from `Dockerfile: node:20`)
- **Axios:** ^1.12.2
- **Native FormData/Blob:** Available since Node.js 18

## Suggested Fix

**Option A — Let axios derive headers from FormData (recommended):**

Axios 1.x can derive multipart headers if you explicitly spread the FormData headers:

```typescript
const addResponse = await axios.post(
  "https://ipfs.blockfrost.io/api/v0/ipfs/add",
  formData,
  {
    headers: {
      project_id: projectId,
      ...formData.getHeaders?.(),  // not available on native FormData
    },
  }
);
```

However, native `FormData` does not have `.getHeaders()`. So the better approach:

**Option B — Use `form-data` npm package:**

```typescript
import FormData from "form-data";

const formData = new FormData();
formData.append("file", Buffer.from(JSON.stringify(json)), {
  filename: "metadata.jsonld",
  contentType: "application/json",
});

const addResponse = await axios.post(
  "https://ipfs.blockfrost.io/api/v0/ipfs/add",
  formData,
  {
    headers: {
      project_id: projectId,
      ...formData.getHeaders(),
    },
  }
);
```

**Option C — Use native `fetch` instead of axios:**

```typescript
const blob = new Blob([JSON.stringify(json)], { type: "application/json" });
const formData = new FormData();
formData.append("file", blob, "metadata.jsonld");

const addResponse = await fetch("https://ipfs.blockfrost.io/api/v0/ipfs/add", {
  method: "POST",
  headers: { project_id: projectId },
  body: formData,
});

const addData = await addResponse.json();
const cid = addData.ipfs_hash;
```

Native `fetch` (available in Node.js 18+) correctly handles `FormData` boundaries automatically, matching browser behavior. This is the simplest fix — no new dependencies, minimal code change.

## Implementation Plan

**Chosen approach: Option C — native `fetch`**

Native `fetch` (available since Node.js 18; production runs Node 20) correctly handles `FormData` boundaries automatically, matching browser behavior. This is the simplest fix: no new dependencies, minimal code change.

### Changes to `src/controllers/data/uploadToIpfs.ts`

1. Remove the `axios` import (only used for the two Blockfrost calls in this file)
2. Replace the upload `axios.post` call with `fetch`, passing `formData` as the body
3. Replace the pin `axios.post` call with `fetch`
4. Update response parsing: use `await response.json()` instead of `response.data`
5. Add `response.ok` checks — `fetch` does not throw on non-2xx status codes

### Resulting code

```typescript
// Upload to Blockfrost IPFS
const addResponse = await fetch(
  "https://ipfs.blockfrost.io/api/v0/ipfs/add",
  {
    method: "POST",
    headers: { project_id: projectId },
    body: formData,
  }
);

if (!addResponse.ok) {
  const errorBody = await addResponse.text();
  throw new Error(`Blockfrost IPFS add failed (${addResponse.status}): ${errorBody}`);
}

const addData = await addResponse.json();
const cid = addData.ipfs_hash;

// Pin the uploaded content so it's not garbage collected
const pinResponse = await fetch(
  `https://ipfs.blockfrost.io/api/v0/ipfs/pin/add/${cid}`,
  {
    method: "POST",
    headers: { project_id: projectId },
  }
);

if (!pinResponse.ok) {
  const errorBody = await pinResponse.text();
  throw new Error(`Blockfrost IPFS pin failed (${pinResponse.status}): ${errorBody}`);
}
```

### No other files affected

- Route registration (`src/routes/data.route.ts`) — unchanged
- Frontend code — correct as-is (sends `{ json: object }` as JSON)
- No new dependencies required

### Verification

1. `npx tsc --noEmit` — confirm TypeScript compiles
2. Test `POST /data/ipfs/upload` with body `{ "json": { "body": { "comment": "test" } } }`
3. Confirm response: `{ success: true, cid: "...", url: "https://ipfs.io/ipfs/..." }`
4. Verify the returned IPFS URL is accessible and serves the uploaded JSON

## Notes

- This bug has existed since the endpoint was first added (commit `104da87`).
- The frontend changes (free-form text rationale) are unrelated — the payload structure (`{ json: object }`) is identical. The bug affects all IPFS uploads regardless of content.
