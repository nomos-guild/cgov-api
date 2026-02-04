#!/usr/bin/env node
/**
 * cgov-api MCP Server
 *
 * Model Context Protocol server that exposes cgov-api backend project knowledge
 * for AI coding assistants. Provides tools and resources for understanding
 * the codebase structure, database schema, API endpoints, and conventions.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  PROJECT_OVERVIEW,
  FILE_STRUCTURE,
  DATABASE_SCHEMA,
  API_ENDPOINTS,
  DATA_INGESTION,
  VOTE_CALCULATION,
  RESPONSE_TYPES,
  DATA_CONVENTIONS,
  CODING_CONVENTIONS,
  COMMON_TASKS,
  ENVIRONMENT_VARIABLES,
  DEPLOYMENT,
  ALL_KNOWLEDGE,
} from "./knowledge/project-knowledge.js";

// =============================================================================
// SERVER SETUP
// =============================================================================

const server = new Server(
  {
    name: "cgov-api-project",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// =============================================================================
// TOOLS
// =============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_project_overview",
        description:
          "Get high-level overview of the cgov-api backend including tech stack, features, and purpose",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get_file_structure",
        description:
          "Get the project file structure with descriptions of each directory and key files",
        inputSchema: {
          type: "object",
          properties: {
            directory: {
              type: "string",
              description:
                "Specific directory to get structure for (e.g., 'controllers', 'services', 'routes', 'jobs'). Leave empty for full structure.",
            },
          },
          required: [],
        },
      },
      {
        name: "get_database_schema",
        description:
          "Get Prisma database schema information including models, fields, relations, and enums",
        inputSchema: {
          type: "object",
          properties: {
            modelName: {
              type: "string",
              description:
                "Specific model name (e.g., 'Proposal', 'OnchainVote', 'Drep', 'SyncStatus'). Leave empty for all models.",
            },
          },
          required: [],
        },
      },
      {
        name: "get_enum_values",
        description: "Get values for Prisma enums used in the database",
        inputSchema: {
          type: "object",
          properties: {
            enumName: {
              type: "string",
              enum: [
                "GovernanceType",
                "ProposalStatus",
                "VoteType",
                "VoterType",
              ],
              description: "Name of the enum to get values for",
            },
          },
          required: ["enumName"],
        },
      },
      {
        name: "get_api_endpoints",
        description:
          "Get API endpoint documentation including routes, controllers, query params, and response types",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              enum: [
                "overview",
                "proposal",
                "dreps",
                "data",
                "authentication",
                "all",
              ],
              description: "API domain to get endpoints for",
            },
          },
          required: [],
        },
      },
      {
        name: "get_data_ingestion_info",
        description:
          "Get information about data ingestion flow, external APIs (Koios/Blockfrost), cron jobs, and sync mechanisms",
        inputSchema: {
          type: "object",
          properties: {
            aspect: {
              type: "string",
              enum: [
                "flow",
                "koios",
                "blockfrost",
                "cronJobs",
                "governanceTypeMapping",
                "proposalStatusDerivation",
                "all",
              ],
              description: "Specific aspect of data ingestion",
            },
          },
          required: [],
        },
      },
      {
        name: "get_vote_calculation_rules",
        description:
          "Get vote calculation rules for DRep, SPO, or CC voting including formulas, thresholds, and epoch-dependent logic",
        inputSchema: {
          type: "object",
          properties: {
            voterType: {
              type: "string",
              enum: ["DRep", "SPO", "CC"],
              description: "The voter type to get calculation rules for",
            },
            topic: {
              type: "string",
              enum: [
                "thresholds",
                "passingLogic",
                "all",
              ],
              description: "Specific calculation topic",
            },
          },
          required: [],
        },
      },
      {
        name: "get_response_types",
        description:
          "Get API response type definitions for a specific domain",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              enum: ["overview", "proposal", "drep", "governance", "all"],
              description: "Response type domain",
            },
          },
          required: [],
        },
      },
      {
        name: "get_data_conventions",
        description:
          "Get data conventions (lovelace/ADA conversion, BigInt handling, pagination, ID formats)",
        inputSchema: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              enum: [
                "lovelaceToAda",
                "bigIntHandling",
                "proposalIdentifiers",
                "pagination",
                "all",
              ],
              description: "Specific convention topic",
            },
          },
          required: [],
        },
      },
      {
        name: "get_coding_conventions",
        description:
          "Get coding conventions and style guidelines for the backend",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: [
                "typescript",
                "express",
                "prisma",
                "naming",
                "imports",
                "errorHandling",
                "all",
              ],
              description: "Category of conventions",
            },
          },
          required: [],
        },
      },
      {
        name: "get_task_guidance",
        description:
          "Get step-by-step guidance for common backend development tasks",
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              enum: [
                "addNewEndpoint",
                "addNewPrismaModel",
                "addNewCronJob",
                "addNewIngestionService",
              ],
              description: "The task to get guidance for",
            },
          },
          required: ["task"],
        },
      },
      {
        name: "get_environment_variables",
        description:
          "Get environment variable documentation (required and optional)",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get_deployment_info",
        description:
          "Get deployment configuration including Docker, GCP Cloud Run, and npm scripts",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "search_project_knowledge",
        description: "Search across all backend project knowledge by keyword",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Search query (e.g., 'lovelace', 'DRep', 'threshold', 'Prisma', 'cron')",
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

// =============================================================================
// TOOL HANDLERS
// =============================================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_project_overview": {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(PROJECT_OVERVIEW, null, 2),
          },
        ],
      };
    }

    case "get_file_structure": {
      const directory = args?.directory as string | undefined;
      if (
        directory &&
        FILE_STRUCTURE.src[directory as keyof typeof FILE_STRUCTURE.src]
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  [directory]:
                    FILE_STRUCTURE.src[
                      directory as keyof typeof FILE_STRUCTURE.src
                    ],
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(FILE_STRUCTURE, null, 2),
          },
        ],
      };
    }

    case "get_database_schema": {
      const modelName = args?.modelName as string | undefined;
      if (modelName) {
        const model =
          DATABASE_SCHEMA.models[
            modelName as keyof typeof DATABASE_SCHEMA.models
          ];
        if (model) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { name: modelName, ...model },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const enumInfo =
          DATABASE_SCHEMA.enums[
            modelName as keyof typeof DATABASE_SCHEMA.enums
          ];
        if (enumInfo) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { type: "enum", name: modelName, ...enumInfo },
                  null,
                  2
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Model or enum '${modelName}' not found`,
                  availableModels: Object.keys(DATABASE_SCHEMA.models),
                  availableEnums: Object.keys(DATABASE_SCHEMA.enums),
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(DATABASE_SCHEMA, null, 2),
          },
        ],
      };
    }

    case "get_enum_values": {
      const enumName = args?.enumName as string;
      const enumInfo =
        DATABASE_SCHEMA.enums[enumName as keyof typeof DATABASE_SCHEMA.enums];
      if (enumInfo) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { name: enumName, ...enumInfo },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Enum '${enumName}' not found`,
                availableEnums: Object.keys(DATABASE_SCHEMA.enums),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "get_api_endpoints": {
      const domain = args?.domain as string | undefined;
      if (domain && domain !== "all") {
        if (domain === "authentication") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(API_ENDPOINTS.authentication, null, 2),
              },
            ],
          };
        }
        const routes =
          API_ENDPOINTS.routes[
            domain as keyof typeof API_ENDPOINTS.routes
          ];
        if (routes) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ [domain]: routes }, null, 2),
              },
            ],
          };
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(API_ENDPOINTS, null, 2),
          },
        ],
      };
    }

    case "get_data_ingestion_info": {
      const aspect = args?.aspect as string | undefined;
      if (aspect && aspect !== "all") {
        if (aspect === "koios") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  DATA_INGESTION.externalApis.koios,
                  null,
                  2
                ),
              },
            ],
          };
        }
        if (aspect === "blockfrost") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  DATA_INGESTION.externalApis.blockfrost,
                  null,
                  2
                ),
              },
            ],
          };
        }
        const value =
          DATA_INGESTION[aspect as keyof typeof DATA_INGESTION];
        if (value) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ [aspect]: value }, null, 2),
              },
            ],
          };
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(DATA_INGESTION, null, 2),
          },
        ],
      };
    }

    case "get_vote_calculation_rules": {
      const voterType = args?.voterType as string | undefined;
      const topic = args?.topic as string | undefined;

      if (topic === "thresholds") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                VOTE_CALCULATION.votingThresholds,
                null,
                2
              ),
            },
          ],
        };
      }

      if (topic === "passingLogic") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  passingLogic:
                    VOTE_CALCULATION.votingThresholds.passingLogic,
                  thresholds:
                    VOTE_CALCULATION.votingThresholds.thresholds,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (voterType === "DRep") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  voterType: "DRep",
                  ...VOTE_CALCULATION.drepCalculation,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (voterType === "SPO") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  voterType: "SPO",
                  ...VOTE_CALCULATION.spoCalculation,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (voterType === "CC") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  voterType: "CC",
                  ...VOTE_CALCULATION.ccCalculation,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(VOTE_CALCULATION, null, 2),
          },
        ],
      };
    }

    case "get_response_types": {
      const domain = args?.domain as string | undefined;
      if (
        domain &&
        domain !== "all" &&
        RESPONSE_TYPES[domain as keyof typeof RESPONSE_TYPES]
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  [domain]:
                    RESPONSE_TYPES[
                      domain as keyof typeof RESPONSE_TYPES
                    ],
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(RESPONSE_TYPES, null, 2),
          },
        ],
      };
    }

    case "get_data_conventions": {
      const topic = args?.topic as string | undefined;
      if (
        topic &&
        topic !== "all" &&
        DATA_CONVENTIONS[topic as keyof typeof DATA_CONVENTIONS]
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  [topic]:
                    DATA_CONVENTIONS[
                      topic as keyof typeof DATA_CONVENTIONS
                    ],
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(DATA_CONVENTIONS, null, 2),
          },
        ],
      };
    }

    case "get_coding_conventions": {
      const category = args?.category as string | undefined;
      if (
        category &&
        category !== "all" &&
        CODING_CONVENTIONS[category as keyof typeof CODING_CONVENTIONS]
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  [category]:
                    CODING_CONVENTIONS[
                      category as keyof typeof CODING_CONVENTIONS
                    ],
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(CODING_CONVENTIONS, null, 2),
          },
        ],
      };
    }

    case "get_task_guidance": {
      const task = args?.task as string;
      const guidance =
        COMMON_TASKS[task as keyof typeof COMMON_TASKS];
      if (guidance) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ task, ...guidance }, null, 2),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Task '${task}' not found`,
                availableTasks: Object.keys(COMMON_TASKS),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "get_environment_variables": {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(ENVIRONMENT_VARIABLES, null, 2),
          },
        ],
      };
    }

    case "get_deployment_info": {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(DEPLOYMENT, null, 2),
          },
        ],
      };
    }

    case "search_project_knowledge": {
      const query = (args?.query as string).toLowerCase();
      const results: Record<string, unknown>[] = [];

      const searchObject = (obj: unknown, path: string): void => {
        if (typeof obj === "string" && obj.toLowerCase().includes(query)) {
          results.push({ path, value: obj });
        } else if (Array.isArray(obj)) {
          obj.forEach((item, index) =>
            searchObject(item, `${path}[${index}]`)
          );
        } else if (typeof obj === "object" && obj !== null) {
          for (const [key, value] of Object.entries(obj)) {
            if (key.toLowerCase().includes(query)) {
              results.push({ path: `${path}.${key}`, value });
            }
            searchObject(value, `${path}.${key}`);
          }
        }
      };

      searchObject(ALL_KNOWLEDGE, "knowledge");

      const limitedResults = results.slice(0, 20);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query,
                resultCount: results.length,
                results: limitedResults,
                truncated: results.length > 20,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// =============================================================================
// RESOURCES
// =============================================================================

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "cgov-api://overview",
        name: "Project Overview",
        description:
          "Complete backend project overview including tech stack and features",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://file-structure",
        name: "File Structure",
        description: "Project file and directory structure",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://database-schema",
        name: "Database Schema",
        description:
          "Prisma database schema with all models, fields, relations, and enums",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://api-endpoints",
        name: "API Endpoints",
        description: "All API endpoints with routes, params, and response types",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://data-ingestion",
        name: "Data Ingestion",
        description:
          "Data ingestion flow, external APIs, cron jobs, and sync mechanisms",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://vote-calculation",
        name: "Vote Calculation",
        description:
          "Vote calculation formulas for DRep, SPO, CC with thresholds and epoch logic",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://response-types",
        name: "Response Types",
        description: "API response type definitions",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://conventions",
        name: "Coding Conventions",
        description: "Backend coding conventions and style guidelines",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://data-conventions",
        name: "Data Conventions",
        description:
          "Data format conventions (lovelace/ADA, BigInt, pagination, IDs)",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://environment",
        name: "Environment Variables",
        description: "Required and optional environment variables",
        mimeType: "application/json",
      },
      {
        uri: "cgov-api://complete",
        name: "Complete Knowledge Base",
        description: "All backend project knowledge in one document",
        mimeType: "application/json",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  const resourceMap: Record<string, unknown> = {
    "cgov-api://overview": PROJECT_OVERVIEW,
    "cgov-api://file-structure": FILE_STRUCTURE,
    "cgov-api://database-schema": DATABASE_SCHEMA,
    "cgov-api://api-endpoints": API_ENDPOINTS,
    "cgov-api://data-ingestion": DATA_INGESTION,
    "cgov-api://vote-calculation": VOTE_CALCULATION,
    "cgov-api://response-types": RESPONSE_TYPES,
    "cgov-api://conventions": CODING_CONVENTIONS,
    "cgov-api://data-conventions": DATA_CONVENTIONS,
    "cgov-api://environment": ENVIRONMENT_VARIABLES,
    "cgov-api://complete": ALL_KNOWLEDGE,
  };

  const data = resourceMap[uri];
  if (data) {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// =============================================================================
// START SERVER
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cgov-api Project MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
