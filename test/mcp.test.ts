import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { handleToolCall, parseConfig, TOOLS, verifyUserKeyScopes } from "../src/index.js";
import type { McpServerConfig } from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const baseConfig: McpServerConfig = {
  apiKey: "test_api_key",
  userKey: "test_user_key",
  baseUrl: "https://api.otpy.ir",
};

describe("otpy mcp server", () => {
  describe("parseConfig", () => {
    it("parses apiKey/userKey/baseUrl from cli args", () => {
      const config = parseConfig(
        ["--api-key", "otpy_cli_key", "--user-key", "otpy_uk_cli_key", "--base-url", "https://custom.example"],
        {},
      );
      expect(config).toEqual({
        apiKey: "otpy_cli_key",
        userKey: "otpy_uk_cli_key",
        baseUrl: "https://custom.example",
      });
    });

    it("parses apiKey/userKey from env vars, defaulting baseUrl", () => {
      const config = parseConfig([], { OTPY_API_KEY: "otpy_env_key", OTPY_USER_KEY: "otpy_uk_env_key" });
      expect(config).toEqual({
        apiKey: "otpy_env_key",
        userKey: "otpy_uk_env_key",
        baseUrl: "https://api.otpy.ir",
      });
    });

    it("has no writeEnabled field at all -- the old client-only flag is gone, not just unused", () => {
      const config = parseConfig(["--write"], { OTPY_MCP_WRITE: "true" });
      expect(config).not.toHaveProperty("writeEnabled");
      expect(Object.keys(config).sort()).toEqual(["apiKey", "baseUrl", "userKey"]);
    });

    it("silently ignores the legacy --write flag and OTPY_MCP_WRITE env var (no-op, not an error)", () => {
      const config = parseConfig(["--api-key", "k", "--write"], { OTPY_MCP_WRITE: "1" });
      expect(config.apiKey).toBe("k");
      // No exception, no hidden field -- parseConfig simply has nothing left that reads these.
    });
  });

  describe("TOOLS", () => {
    it("lists read and write tools", () => {
      expect(TOOLS.some((t) => t.name === "get_usage")).toBe(true);
      expect(TOOLS.some((t) => t.name === "get_balance")).toBe(true);
      expect(TOOLS.some((t) => t.name === "send_test_otp")).toBe(true);
    });

    it("no longer references the old Write Mode / dashboard-toggle mechanism in tool descriptions", () => {
      for (const tool of TOOLS) {
        expect(tool.description).not.toMatch(/Write Mode/i);
        expect(tool.description).not.toMatch(/OTPY_MCP_WRITE/);
      }
    });

    it("describes write-gated tools as requiring a real, server-verified user_key scope", () => {
      const writeTool = TOOLS.find((t) => t.name === "send_test_otp")!;
      expect(writeTool.description).toMatch(/user_key/);
      expect(writeTool.description).toMatch(/write/);
    });
  });

  describe("verifyUserKeyScopes (real, server-verified scope check)", () => {
    it("calls GET /v1/user-keys/self with the user_key as a bearer token", async () => {
      const mockFetch = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: true, billing: false, root: false, enabled: true }),
      );

      const result = await verifyUserKeyScopes(baseConfig, mockFetch as unknown as typeof fetch);

      expect(result).toEqual({
        ok: true,
        scopes: { write: true, billing: false, root: false, enabled: true },
        projectAllowed: null,
      });
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/user-keys/self");
      expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test_user_key" });
    });

    it("passes project_id as a query param and surfaces project_allowed when present", async () => {
      const mockFetch = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: true, billing: true, root: true, enabled: true, project_allowed: false }),
      );

      const result = await verifyUserKeyScopes(baseConfig, mockFetch as unknown as typeof fetch, "proj_123");

      expect(result).toEqual({
        ok: true,
        scopes: { write: true, billing: true, root: true, enabled: true },
        projectAllowed: false,
      });
      const [url] = mockFetch.mock.calls[0]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/user-keys/self?project_id=proj_123");
    });

    it("treats a missing userKey as all-scopes-false rather than erroring (read tools still work)", async () => {
      const mockFetch = vi.fn();
      const result = await verifyUserKeyScopes({ ...baseConfig, userKey: "" }, mockFetch as unknown as typeof fetch);

      expect(result).toEqual({
        ok: true,
        scopes: { write: false, billing: false, root: false, enabled: false },
        projectAllowed: null,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fails closed (ok: false) when the API rejects the user_key with 401", async () => {
      const mockFetch = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
      const result = await verifyUserKeyScopes(baseConfig, mockFetch as unknown as typeof fetch);
      expect(result.ok).toBe(false);
    });

    it("fails closed (ok: false) on a network error", async () => {
      const mockFetch = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      const result = await verifyUserKeyScopes(baseConfig, mockFetch as unknown as typeof fetch);
      expect(result.ok).toBe(false);
    });
  });

  describe("handleToolCall: real server-verified scope gating (not the old local flag)", () => {
    it("denies a write tool when the server reports write:false, even though the legacy env var claims otherwise", async () => {
      // The brief's exact scenario: an operator sets OTPY_MCP_WRITE=true locally, but the
      // real user_key on file has write:false. parseConfig no longer even has a field for
      // the legacy flag (see above), so there is nothing for it to influence here -- the
      // live scope response is the only thing that matters.
      parseConfig(["--write"], { OTPY_MCP_WRITE: "true" }); // legacy inputs: proven inert above
      const scopeFetch = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: false, billing: false, root: false, enabled: true }),
      );

      const res = await handleToolCall("send_test_otp", { phone: "09123456789" }, baseConfig, scopeFetch as unknown as typeof fetch);

      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("write");
      expect(scopeFetch).toHaveBeenCalled();
    });

    it("permits a write tool when the server reports write:true, with no legacy flag involved at all", async () => {
      const fetchFn = vi
        .fn()
        // First call: scope verification.
        .mockImplementationOnce(async () =>
          jsonResponse({ user_key_id: "uk1", write: true, billing: false, root: false, enabled: true }),
        )
        // Second call: the actual send_test_otp request.
        .mockImplementationOnce(async () => jsonResponse({ request_id: "test_req_123", free: true }));

      const res = await handleToolCall(
        "send_test_otp",
        { phone: "09123456789" },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain("test_req_123");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("denies a write tool outright when no userKey is configured at all", async () => {
      const scopeFetch = vi.fn();
      const res = await handleToolCall(
        "verify_test_otp",
        { phone: "09123456789", code: "123456" },
        { ...baseConfig, userKey: "" },
        scopeFetch as unknown as typeof fetch,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("user_key");
    });

    it("denies a billing tool (get_balance) when the server reports billing:false", async () => {
      const scopeFetch = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: true, billing: false, root: false, enabled: true }),
      );
      const res = await handleToolCall("get_balance", {}, baseConfig, scopeFetch as unknown as typeof fetch);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("billing");
    });

    it("permits a billing tool (get_balance) when the server reports billing:true", async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () =>
          jsonResponse({ user_key_id: "uk1", write: false, billing: true, root: false, enabled: true }),
        )
        .mockImplementationOnce(async () => jsonResponse({ balance_toman: 5000 }));

      const res = await handleToolCall(
        "get_balance",
        { project_id: "proj_1" },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain("balance_toman");
      const [url, init] = fetchFn.mock.calls[1]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/mcp-scope/balance?project_id=proj_1");
      expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test_user_key" });
    });

    it("rejects get_balance without project_id after the scope gate passes", async () => {
      const fetchFn = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: false, billing: true, root: false, enabled: true }),
      );
      const res = await handleToolCall("get_balance", {}, baseConfig, fetchFn as unknown as typeof fetch);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("project_id is required");
    });

    it("wires list_api_keys to GET /v1/mcp-scope/projects/:projectId/api-keys", async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () =>
          jsonResponse({ user_key_id: "uk1", write: false, billing: true, root: false, enabled: true }),
        )
        .mockImplementationOnce(async () => jsonResponse({ api_keys: [{ id: "ak_1", name: "default" }] }));

      const res = await handleToolCall(
        "list_api_keys",
        { project_id: "proj_1" },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      const [url] = fetchFn.mock.calls[1]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/mcp-scope/projects/proj_1/api-keys");
      expect(res.content[0]?.text).toContain("ak_1");
    });

    it("denies write tools requiring project access when project_allowed is false for the given project_id", async () => {
      const fetchFn = vi.fn(async () =>
        jsonResponse({
          user_key_id: "uk1",
          write: true,
          billing: true,
          root: true,
          enabled: true,
          project_allowed: false,
        }),
      );

      const res = await handleToolCall(
        "create_api_key",
        { project_id: "proj_not_granted", name: "x" },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("not granted access");
    });

    it("wires create_api_key to POST /v1/mcp-scope/projects/:projectId/api-keys when the gate passes", async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () =>
          jsonResponse({
            user_key_id: "uk1",
            write: true,
            billing: false,
            root: false,
            enabled: true,
            project_allowed: true,
          }),
        )
        .mockImplementationOnce(async () =>
          jsonResponse({ api_key_id: "ak_new", api_key: "otpy_secret_once", key_prefix: "otpy_secr", version: 0 }),
        );

      const res = await handleToolCall(
        "create_api_key",
        { project_id: "proj_granted", name: "x", limit_daily_otp: 100 },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      const [url, init] = fetchFn.mock.calls[1]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/mcp-scope/projects/proj_granted/api-keys");
      expect((init as RequestInit).method).toBe("POST");
      expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test_user_key" });
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "x", limit_daily_otp: 100 });
      expect(res.content[0]?.text).toContain("ak_new");
    });

    it("executes read tools (get_usage) regardless of scopes, without calling scope verification", async () => {
      const mockFetch = vi.fn(async () =>
        jsonResponse({
          free_used_today: 1,
          free_quota_today: 10,
          paid_today: 0,
          daily_limit: 100,
        }),
      );

      const res = await handleToolCall("get_usage", {}, baseConfig, mockFetch as unknown as typeof fetch);
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain("free_used_today");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.otpy.ir/v1/usage",
        expect.objectContaining({ headers: { authorization: "Bearer test_api_key" } }),
      );
    });
  });

  describe("bin startup", () => {
    const distPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

    it("starts the server when invoked through a symlink (npm bin link)", () => {
      if (!existsSync(distPath)) return; // requires `pnpm build` first
      const dir = mkdtempSync(join(tmpdir(), "otpy-mcp-link-"));
      try {
        const link = join(dir, "otpy-mcp");
        symlinkSync(distPath, link);
        const result = spawnSync(process.execPath, [link], {
          encoding: "utf8",
          input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"serverInfo"');
        const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
        expect(result.stdout).toContain(`"version":"${pkg.version}"`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("single-sources the server version from package.json", () => {
      if (!existsSync(distPath)) return; // requires `pnpm build` first
      const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
      const result = spawnSync(process.execPath, [distPath], {
        encoding: "utf8",
        input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`"version":"${pkg.version}"`);
    });
  });
});
