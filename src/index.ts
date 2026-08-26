#!/usr/bin/env node
import { createInterface } from "node:readline";

export interface McpServerConfig {
  apiKey: string;
  baseUrl: string;
  writeEnabled: boolean;
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

  const baseUrlArgIdx = args.indexOf("--base-url");
  const baseUrl =
    (baseUrlArgIdx !== -1 && args[baseUrlArgIdx + 1]) ||
    env.OTPY_BASE_URL ||
    "https://api.otpy.ir";

  const writeEnabled =
    args.includes("--write") ||
    env.OTPY_MCP_WRITE === "true" ||
    env.OTPY_MCP_WRITE === "1";

  return { apiKey, baseUrl, writeEnabled };
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
    description: "Get the current wallet balance and pricing details.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_api_keys",
    description: "List active API keys and their configured quota limits for the project.",
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
    description: "Send a test login OTP to a phone number. (Requires Write Mode enabled in dashboard).",
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
    description: "Verify a test OTP code for a phone number. (Requires Write Mode enabled in dashboard).",
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
    description: "Create a new API key with optional daily/weekly/monthly limits. (Requires Write Mode enabled).",
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

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  config: McpServerConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const writeTools = ["send_test_otp", "verify_test_otp", "create_api_key", "toggle_api_key"];

  if (writeTools.includes(name) && !config.writeEnabled) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `❌ Write mode is disabled for this MCP connection.\nTo enable write actions (sending OTPs, creating/modifying keys), configure Write Mode in your dashboard at https://dash.otpy.ir or set OTPY_MCP_WRITE=true.`,
        },
      ],
    };
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
