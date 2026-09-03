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
    const projectId = typeof args.project_id === "string" && args.project_id ? args.project_id : null;
    if (!projectId) {
      return { isError: true, content: [{ type: "text", text: "Error: project_id is required." }] };
    }
    try {
      const url = new URL(`${config.baseUrl}/v1/mcp-scope/balance`);
      url.searchParams.set("project_id", projectId);
      const res = await fetchFn(url.toString(), {
        headers: { authorization: `Bearer ${config.userKey}` },
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Network error: ${String(err)}` }] };
    }
  }

  if (name === "get_integration_snippet") {
    const lang = String(args.language || "nodejs");
    const key = config.apiKey || "otpy_your_api_key";
    let snippet = "";
    if (lang === "python") {
      snippet = `import requests\nres = requests.post("https://api.otpy.ir/v1/otp/send", json={"phone": "09123456789"}, headers={"Authorization": "Bearer ${key}"})\nprint(res.json())`;
    } else if (lang === "curl") {
      snippet = `curl -X POST https://api.otpy.ir/v1/otp/send -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"phone": "09123456789"}'`;
    } else if (lang === "go") {
      snippet = `package main\n\nimport (\n\t"bytes"\n\t"encoding/json"\n\t"fmt"\n\t"net/http"\n)\n\nfunc main() {\n\tpayload, _ := json.Marshal(map[string]string{"phone": "09123456789"})\n\treq, _ := http.NewRequest("POST", "https://api.otpy.ir/v1/otp/send", bytes.NewBuffer(payload))\n\treq.Header.Set("Authorization", "Bearer ${key}")\n\treq.Header.Set("Content-Type", "application/json")\n\tresp, err := http.DefaultClient.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer resp.Body.Close()\n\tvar result map[string]any\n\tjson.NewDecoder(resp.Body).Decode(&result)\n\tfmt.Println(result)\n}`;
    } else if (lang === "php") {
      snippet = `<?php\nuse Illuminate\\Support\\Facades\\Http;\n\n$response = Http::withToken('${key}')\n    ->acceptJson()\n    ->post('https://api.otpy.ir/v1/otp/send', [\n        'phone' => '09123456789',\n    ]);\n\nreturn $response->json();`;
    } else if (lang === "csharp") {
      snippet = `using System.Net.Http;\nusing System.Net.Http.Headers;\nusing System.Text;\n\nusing var client = new HttpClient();\nclient.DefaultRequestHeaders.Authorization =\n    new AuthenticationHeaderValue("Bearer", "${key}");\n\nvar content = new StringContent(\n    "{\\"phone\\":\\"09123456789\\"}",\n    Encoding.UTF8,\n    "application/json");\n\nvar response = await client.PostAsync("https://api.otpy.ir/v1/otp/send", content);\nvar body = await response.Content.ReadAsStringAsync();\nConsole.WriteLine(body);`;
    } else {
      snippet = `import { OtpyClient } from "@o-t-p-y/sdk";\nconst otpy = new OtpyClient({ apiKey: "${key}" });\nawait otpy.sendOtp("09123456789");`;
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

  if (name === "list_api_keys") {
    const projectId = typeof args.project_id === "string" && args.project_id ? args.project_id : null;
    if (!projectId) {
      return { isError: true, content: [{ type: "text", text: "Error: project_id is required." }] };
    }
    try {
      const res = await fetchFn(`${config.baseUrl}/v1/mcp-scope/projects/${projectId}/api-keys`, {
        headers: { authorization: `Bearer ${config.userKey}` },
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Network error: ${String(err)}` }] };
    }
  }

  if (name === "create_api_key") {
    const projectId = typeof args.project_id === "string" && args.project_id ? args.project_id : null;
    if (!projectId) {
      return { isError: true, content: [{ type: "text", text: "Error: project_id is required." }] };
    }
    const body: Record<string, unknown> = { name: String(args.name ?? "") };
    for (const key of ["limit_daily_otp", "limit_weekly_otp", "limit_monthly_otp"] as const) {
      if (typeof args[key] === "number") body[key] = args[key];
    }
    try {
      const res = await fetchFn(`${config.baseUrl}/v1/mcp-scope/projects/${projectId}/api-keys`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.userKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Network error: ${String(err)}` }] };
    }
  }

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
  startMcpServer();
}
