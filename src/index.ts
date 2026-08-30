#!/usr/bin/env node
import { createInterface } from "node:readline";

// Task 30 (#13): the MCP server holds up to TWO credentials:
//  - `apiKey`: the existing project-scoped `api_keys` credential (Task 2/#? --
//    product_authenticate_api_key), used for the read/write OTP-related tools
//    that hit /v1/usage, /v1/otp/send, /v1/otp/verify, etc.
//  - `userKey`: the NEW user-scoped `user_keys` credential (Task 7/13/30 --
//    otpy_uk_... raw secret), used ONLY to verify write/billing scopes via a
//    real network call to GET /v1/user-keys/self (packages/db/migrations/
//    0018_user_key_authenticate.sql + apps/api/src/routes/v1/user-keys.ts).
//
// There is deliberately no more local-only `writeEnabled` flag (the old
// `--write` / `OTPY_MCP_WRITE` mechanism). That flag was never verified
// server-side -- anyone could set the env var locally and bypass it. Real
// scope gating now always requires a live, server-verified answer from
// `verifyUserKeyScopes` below; there is no client-side override, restrictive
// or otherwise, left in this file.
export interface McpServerConfig {
  apiKey: string;
  userKey: string;
  baseUrl: string;
}

export function parseConfig(
  args: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): McpServerConfig {
  const apiKeyArgIdx = args.indexOf("--api-key");
  const apiKey =
    (apiKeyArgIdx !== -1 && args[apiKeyArgIdx + 1]) ||
    env.OTPY_API_KEY ||
    "";

  const userKeyArgIdx = args.indexOf("--user-key");
  const userKey =
    (userKeyArgIdx !== -1 && args[userKeyArgIdx + 1]) ||
    env.OTPY_USER_KEY ||
    "";

  const baseUrlArgIdx = args.indexOf("--base-url");
  const baseUrl =
    (baseUrlArgIdx !== -1 && args[baseUrlArgIdx + 1]) ||
    env.OTPY_BASE_URL ||
    "https://api.otpy.ir";

  return { apiKey, userKey, baseUrl };
}

export const TOOLS = [
  {
    name: "get_usage",
    description: "Get today's OTP usage statistics (free used, free quota, paid count, daily limit).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_balance",
    description:
      "Get the current wallet balance and pricing details. Requires a user_key with the 'billing' scope (see README).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_api_keys",
    description:
      "List active API keys and their configured quota limits for the project. Requires a user_key with the 'billing' scope (see README).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Optional project ID filter." },
      },
      required: [],
    },
  },
  {
    name: "get_integration_snippet",
    description: "Get ready-to-use code integration snippet for a specific language (nodejs, python, go, php, curl, csharp).",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["nodejs", "python", "go", "php", "curl", "csharp"],
          description: "Target programming language.",
        },
      },
      required: ["language"],
    },
  },
  {
    name: "send_test_otp",
    description:
      "Send a test login OTP to a phone number. Requires a user_key with the 'write' scope, verified live against the OTPy API (see README).",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Iranian phone number in format 09xxxxxxxxx." },
      },
      required: ["phone"],
    },
  },
  {
    name: "verify_test_otp",
    description:
      "Verify a test OTP code for a phone number. Requires a user_key with the 'write' scope, verified live against the OTPy API (see README).",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Iranian phone number in format 09xxxxxxxxx." },
        code: { type: "string", description: "6-digit OTP code." },
      },
      required: ["phone", "code"],
    },
  },
  {
    name: "create_api_key",
    description:
      "Create a new API key with optional daily/weekly/monthly limits. Requires a user_key with the 'write' scope, verified live against the OTPy API (see README).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID." },
        name: { type: "string", description: "Key name." },
        limit_daily_otp: { type: "number", description: "Optional daily OTP limit." },
        limit_weekly_otp: { type: "number", description: "Optional weekly OTP limit." },
        limit_monthly_otp: { type: "number", description: "Optional monthly OTP limit." },
      },
      required: ["project_id", "name"],
    },
  },
];

// Tools requiring the `write` scope on the presented user_key.
const WRITE_TOOLS = ["send_test_otp", "verify_test_otp", "create_api_key"];
// Tools requiring the `billing` scope on the presented user_key.
// Mapping per the plan: billing -> get_balance/list_api_keys/topup endpoints.
// `root` is never a separate gate -- it is just "has both write AND billing".
const BILLING_TOOLS = ["get_balance", "list_api_keys"];

export interface UserKeyScopes {
  write: boolean;
  billing: boolean;
  root: boolean;
  enabled: boolean;
}

export type ScopeVerification =
  | { ok: true; scopes: UserKeyScopes; projectAllowed: boolean | null }
  | { ok: false; reason: string };

/**
 * Real, server-verified scope check -- a live network call to
 * GET /v1/user-keys/self (packages/db/migrations/0018_user_key_authenticate.sql
 * via apps/api/src/routes/v1/user-keys.ts), never a client-side-only flag.
 *
 * When no `userKey` is configured at all, this deliberately returns "ok" with
 * every scope false rather than an error -- read-only tools (get_usage,
 * get_integration_snippet) must keep working with only a project api_key
 * configured, and write/billing tools must be denied (not crash) with a
 * clear message telling the operator to configure OTPY_USER_KEY.
 */
export async function verifyUserKeyScopes(
  config: McpServerConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  projectId?: string,
): Promise<ScopeVerification> {
  if (!config.userKey) {
    return {
      ok: true,
      scopes: { write: false, billing: false, root: false, enabled: false },
      projectAllowed: null,
    };
  }

  try {
    const url = new URL(`${config.baseUrl}/v1/user-keys/self`);
    if (projectId) url.searchParams.set("project_id", projectId);

    const res = await fetchFn(url.toString(), {
      headers: { authorization: `Bearer ${config.userKey}` },
    });

    if (res.status === 401) {
      return { ok: false, reason: "The configured user_key was rejected (invalid, unknown, or revoked)." };
    }
    if (!res.ok) {
      return { ok: false, reason: `Scope verification request failed with status ${res.status}.` };
    }

    const data = (await res.json()) as {
      write?: unknown;
      billing?: unknown;
      root?: unknown;
      enabled?: unknown;
      project_allowed?: unknown;
    };

    if (typeof data.write !== "boolean" || typeof data.billing !== "boolean") {
      return { ok: false, reason: "Scope verification response was malformed." };
    }

    return {
      ok: true,
      scopes: {
        write: data.write,
        billing: data.billing,
        root: Boolean(data.root),
        enabled: Boolean(data.enabled),
      },
      projectAllowed: typeof data.project_allowed === "boolean" ? data.project_allowed : null,
    };
  } catch (err) {
    return { ok: false, reason: `Network error while verifying user_key scopes: ${String(err)}` };
  }
}

function scopeDeniedResult(text: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { isError: true, content: [{ type: "text", text }] };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  config: McpServerConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const needsWrite = WRITE_TOOLS.includes(name);
  const needsBilling = BILLING_TOOLS.includes(name);

  if (needsWrite || needsBilling) {
    const projectId = typeof args.project_id === "string" ? args.project_id : undefined;
    const verification = await verifyUserKeyScopes(config, fetchFn, projectId);

    if (!verification.ok) {
      return scopeDeniedResult(
        `❌ Could not verify this MCP connection's user_key scopes: ${verification.reason}\nConfigure a valid user_key (OTPY_USER_KEY / --user-key), obtained from the "Integrate" tab on https://dash.otpy.ir.`,
      );
    }

    if (!verification.scopes.enabled) {
      return scopeDeniedResult(
        `❌ No valid user_key is configured for this MCP connection.\nThis tool requires a user_key with the required scope. Create one on the "Integrate" tab at https://dash.otpy.ir and set OTPY_USER_KEY (or --user-key).`,
      );
    }

    if (needsWrite && !verification.scopes.write) {
      return scopeDeniedResult(
        `❌ This MCP connection's user_key does not have the 'write' scope.\nWrite actions (sending test OTPs, creating/modifying keys) require a user_key with write enabled. Configure this on the "Integrate" tab at https://dash.otpy.ir.`,
      );
    }

    if (needsBilling && !verification.scopes.billing) {
      return scopeDeniedResult(
        `❌ This MCP connection's user_key does not have the 'billing' scope.\nBilling-related reads (balance, API key listing) require a user_key with billing enabled. Configure this on the "Integrate" tab at https://dash.otpy.ir.`,
      );
    }

    if (projectId && verification.projectAllowed === false) {
      return scopeDeniedResult(
        `❌ This MCP connection's user_key is not granted access to project ${projectId}.\nEither omit project_id, or grant this user_key access to that project on the "Integrate" tab at https://dash.otpy.ir.`,
      );
    }
  }

  if (name === "get_usage") {
    if (!config.apiKey) {
      return { isError: true, content: [{ type: "text", text: "Error: OTPY_API_KEY is not configured." }] };
    }
    try {
      const res = await fetchFn(`${config.baseUrl}/v1/usage`, {
        headers: { authorization: `Bearer ${config.apiKey}` },
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Network error: ${String(err)}` }] };
    }
  }

  if (name === "get_balance") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              default_otp_price_toman: 220,
              free_daily_quota_payg: 10,
              topup_minimum_toman: 100000,
              dashboard_url: "https://dash.otpy.ir/balance",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === "get_integration_snippet") {
    const lang = String(args.language || "nodejs");
    const key = config.apiKey || "otpy_your_api_key";
    let snippet = "";
    if (lang === "python") {
      snippet = `import requests\nres = requests.post("https://api.otpy.ir/v1/otp/send", json={"phone": "09123456789"}, headers={"Authorization": "Bearer ${key}"})\nprint(res.json())`;
    } else if (lang === "curl") {
      snippet = `curl -X POST https://api.otpy.ir/v1/otp/send -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"phone": "09123456789"}'`;
    } else {
      snippet = `import { OtpyClient } from "otpy";\nconst otpy = new OtpyClient({ apiKey: "${key}" });\nawait otpy.sendOtp("09123456789");`;
    }
    return { content: [{ type: "text", text: snippet }] };
  }

  if (name === "send_test_otp") {
    const phone = String(args.phone || "");
    if (!/^09\d{9}$/.test(phone)) {
      return { isError: true, content: [{ type: "text", text: "Invalid phone format. Expected 09xxxxxxxxx." }] };
    }
    try {
      const res = await fetchFn(`${config.baseUrl}/v1/otp/send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Network error: ${String(err)}` }] };
    }
  }

  if (name === "verify_test_otp") {
    const phone = String(args.phone || "");
    const code = String(args.code || "");
    try {
      const res = await fetchFn(`${config.baseUrl}/v1/otp/verify`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ phone, code }),
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Network error: ${String(err)}` }] };
    }
  }

  // `list_api_keys` and `create_api_key` are declared in TOOLS (and are fully
  // scope-gated above, real verification and all) but the underlying API
  // routes they'd call (/v1/projects/:projectId/api-keys) are session-Bearer
  // authenticated (dash-UI-facing), same architectural mismatch as Task 13's
  // introspection endpoint -- the MCP server has neither a session nor a
  // matching credential for those routes yet. Wiring an actual network call
  // for them is out of this task's scope (#13/Task 30 is specifically about
  // replacing the client-only write flag with real scope verification, not
  // adding new tool bodies); they fall through to "Unknown tool" below, same
  // as before this change.

  return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
}

export function startMcpServer(
  config: McpServerConfig = parseConfig(),
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  const rl = createInterface({ input, terminal: false });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try {
      request = JSON.parse(trimmed);
    } catch {
      output.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
      return;
    }

    if (!request.method) return;

    if (request.method === "initialize") {
      output.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "otpy-mcp",
              version: "0.1.0",
            },
          },
        }) + "\n",
      );
      return;
    }

    if (request.method === "notifications/initialized") {
      return;
    }

    if (request.method === "ping") {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n");
      return;
    }

    if (request.method === "tools/list") {
      output.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: TOOLS },
        }) + "\n",
      );
      return;
    }

    if (request.method === "tools/call") {
      const toolName = String((request.params as { name?: string })?.name || "");
      const toolArgs = ((request.params as { arguments?: Record<string, unknown> })?.arguments ||
        {}) as Record<string, unknown>;

      const res = await handleToolCall(toolName, toolArgs, config);
      output.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: res,
        }) + "\n",
      );
      return;
    }

    output.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      }) + "\n",
    );
  });
}

// Auto-start when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer();
}
