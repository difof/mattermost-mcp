import { z } from "zod";
import { describeOperation, resolveOperation, searchOperations } from "../api/discovery.js";
import { assertApiAccess, operationGuard } from "../api/policy.js";
import { callApi } from "../api/client.js";

const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const apiSearch = {
  name: "api_search",
  title: "Find Mattermost API operations",
  description:
    "Search the pinned Mattermost v11 REST API locally. Returns compact operation IDs, summaries and access/write flags. Page with offset; use api_describe before an unfamiliar operation.",
  inputSchema: z
    .object({
      query: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict(),
  compact: true,
  handler: async (args) => searchOperations(args),
};

const apiDescribe = {
  name: "api_describe",
  title: "Describe a Mattermost API operation",
  description:
    "Load an operation's parameters, request schema, authentication and policy. Referenced schemas are included on demand. Set include_response only when response schemas are needed.",
  inputSchema: z
    .object({
      operation: z.string().min(1),
      include_response: z.boolean().default(false),
    })
    .strict(),
  compact: true,
  handler: async (args) => describeOperation(args),
};

const apiCall = {
  name: "api_call",
  title: "Call a Mattermost API operation",
  description:
    "Call a catalog operation using the configured account. Get the operation ID and inputs from api_search/api_describe. Uses path parameters, query and JSON body; uploads accept files or body_base64. Returns HTTP status, selected headers and data (binary: body_base64). Read-only and destructive guards apply per operation. Unavailable with team/channel allowlists; use scoped convenience tools there. Special-auth and local-socket routes cannot use the account credential.",
  inputSchema: z
    .object({
      operation: z.string().min(1),
      path: z
        .record(z.union([z.string(), z.number().finite()]))
        .default({})
        .describe("Unencoded path parameter values, without separators."),
      query: z.record(z.union([scalar, z.array(scalar)])).default({}),
      body: z
        .unknown()
        .optional()
        .describe("JSON request value, or multipart text fields when files are supplied."),
      files: z
        .array(
          z
            .object({
              field: z.string().min(1),
              filename: z.string().min(1),
              content_base64: z.string(),
              content_type: z.string().optional(),
            })
            .strict(),
        )
        .min(1)
        .optional(),
      body_base64: z
        .string()
        .optional()
        .describe("Raw bytes for a catalogued binary upload, mutually exclusive with body/files."),
      content_type: z.string().optional(),
      headers: z
        .record(z.string())
        .default({})
        .describe(
          "Declared endpoint headers or Accept, conditional/Range and Connection-Id headers; credentials cannot be overridden.",
        ),
      max_bytes: z
        .number()
        .int()
        .positive()
        .default(1024 * 1024)
        .describe(
          "Maximum decoded response bytes, including errors; increase explicitly for larger downloads.",
        ),
      response_format: z.enum(["auto", "json", "text", "base64"]).default("auto"),
      confirm: z.boolean().optional(),
    })
    .strict(),
  // Conservative MCP annotations; the dispatcher enforces the actual operation.
  write: true,
  destructive: true,
  guard: (args) => operationGuard(resolveOperation(args.operation)),
  compact: true,
  handler: async (args, { session }) => {
    const operation = resolveOperation(args.operation);
    await assertApiAccess(operation, args, session);
    return session.call((client) => callApi(client, operation, args));
  },
};

export const apiTools = [apiSearch, apiDescribe, apiCall];
