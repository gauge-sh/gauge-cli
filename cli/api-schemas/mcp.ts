import { z } from "zod";

import { skillHandleSchema } from "./skills";

export const mcpServerHandleSchema = skillHandleSchema;

export const AGENT_SAFE_SERVER_KEY = /^[A-Za-z0-9_-]+$/;

export function mcpConfigKey(handle: string): string {
  const key = handle.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!AGENT_SAFE_SERVER_KEY.test(key)) {
    throw new Error(
      `MCP server handle ${JSON.stringify(handle)} yields no usable config key ` +
        "(agents accept letters, numbers, '-' and '_')",
    );
  }
  return key;
}

export const MCP_SPEC_VERSION = 1;

export const envVarNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "an environment variable name (letters, digits, underscore; not starting with a digit)",
  );

export const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/,
    "an HTTP header name (a token — no colon, no spaces)",
  );

export const mcpToolSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(4096).optional(),
});
export type McpTool = z.infer<typeof mcpToolSchema>;

const REFUSED_VALUE_KEYS: Record<string, string> = {
  env: "envNames",
  headers: "headerNames",
  http_headers: "headerNames",
  env_http_headers: "headerNames",
  bearer_token_env_var: "headerNames",
};

export const mcpSpecSchema = z
  .object({
    specVersion: z.literal(MCP_SPEC_VERSION),
    transport: z.enum(["stdio", "http"]),
    command: z.string().min(1).max(512).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    envNames: z.array(envVarNameSchema).max(32).optional(),
    url: z.string().url().max(2048).optional(),
    headerNames: z.array(headerNameSchema).max(32).optional(),
    serverName: mcpServerHandleSchema,
    description: z.string().max(4096).optional(),
    tools: z.array(mcpToolSchema).max(256).optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.transport === "stdio") {
      if (!spec.command) {
        ctx.addIssue({
          code: "custom",
          path: ["command"],
          message: "a stdio server needs a command",
        });
      }
      for (const field of ["url", "headerNames"] as const) {
        if (spec[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${field} belongs to an http server — a stdio server is a command`,
          });
        }
      }
      return;
    }
    if (!spec.url) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "an http server needs a url",
      });
    } else if (!/^https?:\/\//i.test(spec.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "an http server's url must be http(s)",
      });
    }
    for (const field of ["command", "args", "envNames"] as const) {
      if (spec[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} belongs to a stdio server — an http server is a url`,
        });
      }
    }
  });
export type McpSpec = z.infer<typeof mcpSpecSchema>;

export function parseMcpSpec(input: unknown): McpSpec {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, replacement] of Object.entries(REFUSED_VALUE_KEYS)) {
      if (key in (input as Record<string, unknown>)) {
        throw new Error(
          `"${key}" is not stored: Gauge never keeps a credential VALUE for an ` +
            `MCP server. Declare ${replacement} ` +
            "instead — the names are what the agent's config references.",
        );
      }
    }
  }
  return mcpSpecSchema.parse(input);
}

export const mcpExposureSchema = z.object({
  serverName: z.string().min(1),
  description: z.string().optional(),
  tools: z.array(mcpToolSchema).default([]),
  envNames: z.array(z.string()).default([]),
  headerNames: z.array(z.string()).default([]),
});
export type McpExposure = z.infer<typeof mcpExposureSchema>;

export const mcpWarningSchema = z.object({
  code: z.enum([
    "unpinned_package",
    "credential_required",
    "value_discarded",
    "flag_ignored",
  ]),
  message: z.string(),
});
export type McpWarning = z.infer<typeof mcpWarningSchema>;

export const mcpSetEntrySchema = z.object({
  serverId: z.string().min(1),
  name: mcpServerHandleSchema,
  label: z.string().min(1),
  specDigest: z.string().min(1),
  spec: mcpSpecSchema,
  exposure: z.record(z.string(), z.unknown()).optional(),
  connectionId: z.string().min(1).optional(),
});
export type McpSetEntry = z.infer<typeof mcpSetEntrySchema>;

export const MAX_MCP_SET_ENTRIES = 8;

export const mcpSetSchema = z
  .array(mcpSetEntrySchema)
  .max(
    MAX_MCP_SET_ENTRIES,
    `a run may prepare at most ${MAX_MCP_SET_ENTRIES} MCP servers`,
  );
export type McpSet = z.infer<typeof mcpSetSchema>;

export const mcpRefSchema = z
  .string()
  .min(3)
  .max(320)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*@[^,]+$/,
    'an MCP server reference must be "name@label" (a bare name is not a reference)',
  );

export const mcpRefsSchema = z.array(mcpRefSchema).max(MAX_MCP_SET_ENTRIES);

export const mcpVersionWireSchema = z.object({
  id: z.string(),
  label: z.string(),
  specDigest: z.string(),
  spec: mcpSpecSchema,
  exposure: mcpExposureSchema,
  warnings: z.array(mcpWarningSchema),
  createdAt: z.string(),
});
export type McpVersionWire = z.infer<typeof mcpVersionWireSchema>;

export const mcpServerListItemSchema = z.object({
  id: z.string(),
  name: mcpServerHandleSchema,
  note: z.string().nullable(),
  latestVersion: mcpVersionWireSchema.nullable(),
  versionCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpServerListItem = z.infer<typeof mcpServerListItemSchema>;

export const listMcpServersResponseSchema = z.object({
  items: z.array(mcpServerListItemSchema),
});
export type ListMcpServersResponse = z.infer<
  typeof listMcpServersResponseSchema
>;

export const mcpServerDetailSchema = mcpServerListItemSchema
  .omit({ latestVersion: true })
  .extend({ versions: z.array(mcpVersionWireSchema) });
export type McpServerDetail = z.infer<typeof mcpServerDetailSchema>;

export const saveMcpServerBodySchema = z.object({
  name: mcpServerHandleSchema,
  spec: z.unknown(),
  label: z.string().min(1).max(120).optional(),
  note: z.string().max(2000).optional(),
});
export type SaveMcpServerBody = z.infer<typeof saveMcpServerBodySchema>;

export const saveMcpServerResponseSchema = z.object({
  serverId: z.string().nullable(),
  handle: z.string(),
  label: z.string(),
  specDigest: z.string(),
  warnings: z.array(mcpWarningSchema),
  unchanged: z.boolean(),
  invocation: z.string(),
});
export type SaveMcpServerResponse = z.infer<typeof saveMcpServerResponseSchema>;

export const updateMcpServerBodySchema = z.object({
  name: mcpServerHandleSchema.optional(),
  note: z.string().max(2000).nullish(),
});
export type UpdateMcpServerBody = z.infer<typeof updateMcpServerBodySchema>;
