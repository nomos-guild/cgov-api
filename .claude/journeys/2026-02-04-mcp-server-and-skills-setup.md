# MCP Server and Skills Setup

**Date**: 2026-02-04
**Summary**: Built the `cgov-api-project` MCP server and three high-impact skills to make Claude Code significantly more effective when working on the cgov-api backend repository.

## What Was Done

1. **Studied the full stack** - Analyzed both cgov (frontend) and cgov-api (backend) repos to understand the architecture, patterns, and domain
2. **Studied the cgov frontend's .claude ecosystem** - Learned the exact MCP server pattern, skill format, journeys, settings, and .mcp.json configuration from the mature frontend setup
3. **Built the cgov-api-project MCP server** - Created a comprehensive MCP server with 14 tools and 11 resources covering all backend domain knowledge (database schema, API endpoints, vote calculation formulas, data ingestion flow, coding conventions, etc.)
4. **Created 3 high-impact skills** - `add-endpoint`, `add-prisma-model`, and `add-cron-job` following exact patterns from the codebase
5. **Made .claude folder public** - Updated .gitignore to track the .claude folder (open source) while still ignoring build artifacts (node_modules, dist)
6. **Created configuration files** - `.mcp.json` for server registration, `settings.local.json` for auto-approving MCP tool calls

## Key Learnings

- **MCP server pattern**: Self-contained npm package in `.claude/mcp/`, ES module with `@modelcontextprotocol/sdk`, stdio transport, compiled TypeScript to `dist/`
- **Knowledge file structure**: Export named constants for each domain area, plus an `ALL_KNOWLEDGE` aggregate for the search tool
- **Skill format**: YAML frontmatter (name, version, created, description, argument-hint, allowed-tools) + markdown body with steps, code templates, conventions tables, and checklists
- **Gitignore for .claude**: Don't ignore the whole folder - only ignore `node_modules` and `dist` inside MCP servers so source is tracked but artifacts aren't
- **Windows path handling**: MCP server paths in `.mcp.json` use forward slashes and relative paths from workspace root
- **Cron job pattern**: In-process boolean guard + optional SyncStatus DB locking for distributed environments (GCP Cloud Run)
- **Vote calculation complexity**: DRep, SPO, and CC each have different formulas, and SPO formula changed at epoch 534 (Plomin Hard Fork). This domain knowledge is critical for the MCP server

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `.gitignore` | Modified | Removed `.claude` from ignore, added specific `node_modules`/`dist` ignores |
| `.mcp.json` | Created | Registers cgov-api-project MCP server |
| `.claude/settings.local.json` | Created | Auto-approves all 14 MCP tools + common bash commands |
| `.claude/mcp/cgov-api-project/package.json` | Created | MCP server package (ES module, @modelcontextprotocol/sdk) |
| `.claude/mcp/cgov-api-project/package-lock.json` | Created | Dependency lock file |
| `.claude/mcp/cgov-api-project/tsconfig.json` | Created | TypeScript config (ES2022/NodeNext) |
| `.claude/mcp/cgov-api-project/src/index.ts` | Created | MCP server with 14 tools + 11 resources (~600 lines) |
| `.claude/mcp/cgov-api-project/src/knowledge/project-knowledge.ts` | Created | Comprehensive backend knowledge base (~600 lines) |
| `.claude/skills/add-endpoint/SKILL.md` | Created | Skill: scaffold Express API endpoint with all wiring |
| `.claude/skills/add-prisma-model/SKILL.md` | Created | Skill: scaffold Prisma model with conventions |
| `.claude/skills/add-cron-job/SKILL.md` | Created | Skill: scaffold cron job with guard + optional DB locking |

## Patterns Discovered

### MCP Server Tool Pattern
```typescript
// Each tool: schema definition in ListTools + handler in CallTool
// Knowledge file exports named constants → tools return JSON.stringify'd slices
// Search tool does recursive object traversal with keyword matching
```

### Skill Argument Pattern
```yaml
---
argument-hint: [domain] [method] [path] [description]
---
# Referenced as $0, $1, $2, $3 in the skill body
```

### .gitignore Pattern for .claude
```gitignore
# Track .claude source, ignore build artifacts
.claude/mcp/*/node_modules
.claude/mcp/*/dist
```

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Single MCP server (not multiple) | Backend is a single cohesive Express app; splitting would add complexity without benefit |
| 14 tools with focused queries | Better than fewer mega-tools; lets Claude fetch only what's needed without flooding context |
| Knowledge in TypeScript (not JSON) | Matches frontend pattern, enables type checking, easier to maintain |
| Three high-impact skills first | add-endpoint, add-prisma-model, add-cron-job cover the most common development tasks |
| .claude folder public/open source | User explicitly requested open source visibility for the Claude Code ecosystem |
| SyncStatus locking as optional in cron skill | Not all jobs need distributed locking; template is there for when it's needed |

## Skills Evolved

No skills needed evolution this session. Three new skills were created from scratch with full codebase knowledge, and the two pre-existing meta-skills (wrap-up, evolve-skill) are generic and don't require backend-specific changes.

| Skill | Status | Notes |
|-------|--------|-------|
| add-endpoint | v1.0.0 (new) | Created this session |
| add-prisma-model | v1.0.0 (new) | Created this session |
| add-cron-job | v1.0.0 (new) | Created this session |
| wrap-up | v1.1.0 (unchanged) | Generic meta-skill, no changes needed |
| evolve-skill | v1.0.0 (unchanged) | Generic meta-skill, no changes needed |
