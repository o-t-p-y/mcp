#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Single source of truth for the server version: package.json. Read at runtime
// (rootDir is src/, so a static JSON import of ../package.json would break tsc).
export const SERVER_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

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

// Flags that take a value: their next arg is never read as --help/--version.
const VALUE_FLAGS = new Set(["--api-key", "--user-key", "--base-url"]);

export function parseCliAction(args: string[] = process.argv.slice(2)): "help" | "version" | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== undefined && VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--version" || arg === "-v") return "version";
  }
  return null;
}

export const HELP_TEXT = `otpy-mcp ${SERVER_VERSION} - OTPy MCP server (stdio)

Usage:
  npx -y @o-t-p-y/mcp [options]

Run by an MCP client (Cursor, Claude Desktop, ...); it speaks JSON-RPC on stdin/stdout.

Options:
  --api-key <key>    Project API key (otpy_...). Env: OTPY_API_KEY
  --user-key <key>   User key (otpy_uk_...) for project reads and write/billing tools. Env: OTPY_USER_KEY
  --base-url <url>   API base URL. Env: OTPY_BASE_URL (default: https://api.otpy.ir)
  -h, --help         Show this help and exit
  -v, --version      Print the version and exit

Docs: https://github.com/o-t-p-y/mcp#readme
`;

/**
 * Human-facing notices for stderr at startup. Pure, so it is unit-testable;
 * stdout is reserved for JSON-RPC and must never carry these.
 */
export function startupNotices(config: McpServerConfig, stdinIsTTY: boolean): string[] {
  const notices: string[] = [];
  if (!config.apiKey && !config.userKey) {
    notices.push(
      "otpy-mcp: warning: neither OTPY_API_KEY nor OTPY_USER_KEY is set; every tool except get_integration_snippet will fail. Pass --api-key / --user-key or set the env vars.",
    );
  }
  if (stdinIsTTY) {
    notices.push(
      "otpy-mcp: waiting for an MCP client on stdin (JSON-RPC). This server is meant to be launched by an MCP client; run with --help for setup.",
    );
  }
  return notices;
}

export const TOOLS = [
  {
    name: "get_usage",
    description:
      "Get OTP usage statistics. Without dates, values cover today. With both from and to (required together), free_used_today and paid_today are totals for the inclusive range up to 90 days, while free_quota_today and daily_limit remain the current plan limits.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", format: "date", description: "Inclusive start date (YYYY-MM-DD); required together with to." },
        to: { type: "string", format: "date", description: "Inclusive end date (YYYY-MM-DD); required together with from." },
      },
      required: [],
    },
  },
  {
    name: "list_projects",
    description: "List the projects visible to the configured OTPY_USER_KEY. This is a read-only user-key operation.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_otp_messages",
    description:
      "List recent OTP messages for a project. Requires an enabled OTPY_USER_KEY, but no write or billing scope. Status is internal processing state and does not provide carrier delivery receipts; verified_at marks user verification.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Number of messages to return (default 50, maximum 100)." },
      },
      required: ["project_id"],
    },
  },
  {
    name: "list_transactions",
    description:
      "List recent wallet ledger transactions for a project. Requires an enabled OTPY_USER_KEY with the billing scope. Amounts are in tomans.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Number of transactions to return (default 50, maximum 100)." },
      },
      required: ["project_id"],
    },
  },
  {
    name: "get_balance",
    description:
      "Get the current wallet balance for a project. Requires a user_key with the 'billing' scope (see README).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID." },
      },
      required: ["project_id"],
    },
  },
  {
    name: "list_api_keys",
    description:
      "List active API keys and their configured quota limits for the project. Requires a user_key with the 'billing' scope (see README).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID." },
      },
      required: ["project_id"],
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
const BILLING_TOOLS = ["get_balance", "list_api_keys", "list_transactions"];
const USER_KEY_TOOLS = ["list_projects", "list_otp_messages", "list_transactions"];

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

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function toolError(text: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { isError: true, content: [{ type: "text", text }] };
}

// Cap for non-JSON bodies (e.g. a proxy's HTML error page) echoed back to the agent.
const MAX_RAW_BODY = 2000;

/**
 * One place for every OTPy API call a tool makes. The body is read as text and
 * then parsed as JSON, so a non-JSON response (a proxy 502 page, an empty 503)
 * becomes the raw text or `HTTP <status>` instead of a JSON SyntaxError, and any
 * non-2xx status is always flagged with `isError`.
 */
async function callApi(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<ToolResult> {
  let res: Response;
  let body: string;
  try {
    res = await fetchFn(url, init);
    body = await res.text();
  } catch (err) {
    return toolError(`Network error: ${String(err)}`);
  }

  let text: string;
  try {
    text = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    const raw = body.trim().slice(0, MAX_RAW_BODY);
    text = res.ok ? raw || `HTTP ${res.status}` : raw ? `HTTP ${res.status}: ${raw}` : `HTTP ${res.status}`;
  }
  return { isError: !res.ok, content: [{ type: "text", text }] };
}

function requireProjectId(args: Record<string, unknown>): string | ToolResult {
  return typeof args.project_id === "string" && args.project_id
    ? args.project_id
    : toolError("Error: project_id is required.");
}

function requireApiKey(config: McpServerConfig): ToolResult | null {
  return config.apiKey ? null : toolError("Error: OTPY_API_KEY is not configured.");
}

const PHONE_RE = /^09\d{9}$/;
// Same pattern the API enforces on POST /v1/otp/verify.
const CODE_RE = /^\d{6}$/;

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  config: McpServerConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ToolResult> {
  const needsWrite = WRITE_TOOLS.includes(name);
  const needsBilling = BILLING_TOOLS.includes(name);
  const needsUserKey = USER_KEY_TOOLS.includes(name);

  if (needsWrite || needsBilling || needsUserKey) {
    const projectId = typeof args.project_id === "string" ? args.project_id : undefined;
    const verification = await verifyUserKeyScopes(config, fetchFn, projectId);

    if (!verification.ok) {
      return toolError(
        `❌ Could not verify this MCP connection's user_key scopes: ${verification.reason}\nConfigure a valid user_key (OTPY_USER_KEY / --user-key), obtained from the "Integration" page at https://dash.otpy.ir/integrate.`,
      );
    }

    if (!verification.scopes.enabled) {
      return toolError(
        `❌ No valid user_key is configured for this MCP connection.\nThis tool requires a user_key with the required scope. Create one on the "Integration" page at https://dash.otpy.ir/integrate and set OTPY_USER_KEY (or --user-key).`,
      );
    }

    if (needsWrite && !verification.scopes.write) {
      return toolError(
        `❌ This MCP connection's user_key does not have the 'write' scope.\nWrite actions (sending test OTPs, creating/modifying keys) require a user_key with write enabled. Configure this on the "Integration" page at https://dash.otpy.ir/integrate.`,
      );
    }

    if (needsBilling && !verification.scopes.billing) {
      return toolError(
        `❌ This MCP connection's user_key does not have the 'billing' scope.\nBilling-related reads (balance, API key listing) require a user_key with billing enabled. Configure this on the "Integration" page at https://dash.otpy.ir/integrate.`,
      );
    }

    if (projectId && verification.projectAllowed === false) {
      return toolError(
        `❌ This MCP connection's user_key is not granted access to project ${projectId}.\nEither omit project_id, or grant this user_key access to that project on the "Integration" page at https://dash.otpy.ir/integrate.`,
      );
    }
  }

  if (name === "get_usage") {
    const missingKey = requireApiKey(config);
    if (missingKey) return missingKey;
    const url = new URL(`${config.baseUrl}/v1/usage`);
    if (typeof args.from === "string") url.searchParams.set("from", args.from);
    if (typeof args.to === "string") url.searchParams.set("to", args.to);
    return callApi(fetchFn, url.toString(), {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
  }

  if (name === "list_projects") {
    return callApi(fetchFn, `${config.baseUrl}/v1/mcp-scope/projects`, {
      headers: { authorization: `Bearer ${config.userKey}` },
    });
  }

  if (name === "list_otp_messages" || name === "list_transactions") {
    const projectId = requireProjectId(args);
    if (typeof projectId !== "string") return projectId;

    const limit = typeof args.limit === "number" ? args.limit : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return toolError("Error: limit must be an integer between 1 and 100.");
    }

    const endpoint = name === "list_otp_messages" ? "otp-messages" : "ledger";
    const url = new URL(
      `${config.baseUrl}/v1/mcp-scope/projects/${encodeURIComponent(projectId)}/${endpoint}`,
    );
    url.searchParams.set("limit", String(limit));
    return callApi(fetchFn, url.toString(), {
      headers: { authorization: `Bearer ${config.userKey}` },
    });
  }

  if (name === "get_balance") {
    const projectId = requireProjectId(args);
    if (typeof projectId !== "string") return projectId;
    const url = new URL(`${config.baseUrl}/v1/mcp-scope/balance`);
    url.searchParams.set("project_id", projectId);
    return callApi(fetchFn, url.toString(), {
      headers: { authorization: `Bearer ${config.userKey}` },
    });
  }

  if (name === "get_integration_snippet") {
    const lang = String(args.language || "nodejs");
    let snippet = "";
    if (lang === "python") {
      snippet = `import os\nimport requests\n\nres = requests.post("https://api.otpy.ir/v1/otp/send", json={"phone": "09123456789"}, headers={"Authorization": f"Bearer {os.environ['OTPY_API_KEY']}"})\nprint(res.json())`;
    } else if (lang === "curl") {
      snippet = `curl -X POST https://api.otpy.ir/v1/otp/send -H "Authorization: Bearer $OTPY_API_KEY" -H "Content-Type: application/json" -d '{"phone": "09123456789"}'`;
    } else if (lang === "go") {
      snippet = `package main\n\nimport (\n\t"bytes"\n\t"encoding/json"\n\t"fmt"\n\t"net/http"\n\t"os"\n)\n\nfunc main() {\n\tpayload, _ := json.Marshal(map[string]string{"phone": "09123456789"})\n\treq, _ := http.NewRequest("POST", "https://api.otpy.ir/v1/otp/send", bytes.NewBuffer(payload))\n\treq.Header.Set("Authorization", "Bearer "+os.Getenv("OTPY_API_KEY"))\n\treq.Header.Set("Content-Type", "application/json")\n\tresp, err := http.DefaultClient.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer resp.Body.Close()\n\tvar result map[string]any\n\tjson.NewDecoder(resp.Body).Decode(&result)\n\tfmt.Println(result)\n}`;
    } else if (lang === "php") {
      // Framework-neutral: plain cURL works in any PHP stack (Laravel, Symfony,
      // WordPress, plain scripts). Do not assume Laravel's Http facade.
      snippet = `<?php\n\n$ch = curl_init('https://api.otpy.ir/v1/otp/send');\ncurl_setopt_array($ch, [\n    CURLOPT_RETURNTRANSFER => true,\n    CURLOPT_POST => true,\n    CURLOPT_HTTPHEADER => [\n        'Authorization: Bearer ' . getenv('OTPY_API_KEY'),\n        'Content-Type: application/json',\n    ],\n    CURLOPT_POSTFIELDS => json_encode(['phone' => '09123456789']),\n]);\n$response = curl_exec($ch);\ncurl_close($ch);\necho $response;`;
    } else if (lang === "csharp") {
      snippet = `using System;\nusing System.Net.Http;\nusing System.Net.Http.Headers;\nusing System.Text;\n\nusing var client = new HttpClient();\nclient.DefaultRequestHeaders.Authorization =\n    new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("OTPY_API_KEY"));\n\nvar content = new StringContent(\n    "{\\"phone\\":\\"09123456789\\"}",\n    Encoding.UTF8,\n    "application/json");\n\nvar response = await client.PostAsync("https://api.otpy.ir/v1/otp/send", content);\nvar body = await response.Content.ReadAsStringAsync();\nConsole.WriteLine(body);`;
    } else {
      snippet = `import { OtpyClient } from "@o-t-p-y/sdk";\nconst otpy = new OtpyClient({ apiKey: process.env.OTPY_API_KEY! });\nawait otpy.sendOtp("09123456789");`;
    }
    return { content: [{ type: "text", text: snippet }] };
  }

  if (name === "send_test_otp") {
    const missingKey = requireApiKey(config);
    if (missingKey) return missingKey;
    const phone = String(args.phone || "");
    if (!PHONE_RE.test(phone)) {
      return toolError("Invalid phone format. Expected 09xxxxxxxxx.");
    }
    return callApi(fetchFn, `${config.baseUrl}/v1/otp/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ phone }),
    });
  }

  if (name === "verify_test_otp") {
    const missingKey = requireApiKey(config);
    if (missingKey) return missingKey;
    const phone = String(args.phone || "");
    if (!PHONE_RE.test(phone)) {
      return toolError("Invalid phone format. Expected 09xxxxxxxxx.");
    }
    const code = String(args.code ?? "").trim();
    if (!CODE_RE.test(code)) {
      return toolError("Invalid code format. Expected a 6-digit code.");
    }
    return callApi(fetchFn, `${config.baseUrl}/v1/otp/verify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ phone, code }),
    });
  }

  if (name === "list_api_keys") {
    const projectId = requireProjectId(args);
    if (typeof projectId !== "string") return projectId;
    return callApi(fetchFn, `${config.baseUrl}/v1/mcp-scope/projects/${encodeURIComponent(projectId)}/api-keys`, {
      headers: { authorization: `Bearer ${config.userKey}` },
    });
  }

  if (name === "create_api_key") {
    const projectId = requireProjectId(args);
    if (typeof projectId !== "string") return projectId;
    const body: Record<string, unknown> = { name: String(args.name ?? "") };
    for (const key of ["limit_daily_otp", "limit_weekly_otp", "limit_monthly_otp"] as const) {
      if (typeof args[key] === "number") body[key] = args[key];
    }
    return callApi(fetchFn, `${config.baseUrl}/v1/mcp-scope/projects/${encodeURIComponent(projectId)}/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.userKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  return toolError(`Unknown tool: ${name}`);
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
              version: SERVER_VERSION,
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

// Auto-start when executed directly. npm links bins via symlink, so argv[1]
// is the link path while import.meta.url is the realpath — compare realpaths.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const action = parseCliAction();
  if (action === "help") {
    process.stdout.write(HELP_TEXT);
  } else if (action === "version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
  } else {
    const config = parseConfig();
    for (const notice of startupNotices(config, Boolean(process.stdin.isTTY))) {
      process.stderr.write(`${notice}\n`);
    }
    startMcpServer(config);
  }
}
