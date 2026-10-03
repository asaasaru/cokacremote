import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires authentication unless explicitly disabled", () => {
    expect(() => loadConfig({}, "/tmp")).toThrow("MCP_AUTH_TOKEN is required");
    expect(loadConfig({ MCP_ALLOW_NO_AUTH: "true" }, "/tmp").allowNoAuth).toBe(true);
  });

  it("loads full-access host settings", () => {
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "secret",
        MCP_PORT: "4321",
        MCP_DEFAULT_CWD: "/",
        MCP_ALLOWED_HOSTS: "mcp.example.com,localhost",
      },
      "/tmp",
    );

    expect(config).toMatchObject({
      port: 4321,
      defaultCwd: "/",
      trustProxyHops: 0,
      authToken: "secret",
      allowedHosts: ["mcp.example.com", "localhost"],
    });
  });

  it("rejects partial integers and ports outside the valid range", () => {
    for (const value of ["3000oops", "3000.9", "70000"]) {
      expect(() =>
        loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_PORT: value }, "/tmp"),
      ).toThrow("MCP_PORT must be an integer between 1 and 65535");
    }
    expect(
      loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_PORT: " 4321 " }, "/tmp").port,
    ).toBe(4321);
  });

  it("requires public HTTPS metadata when OAuth is enabled", () => {
    expect(() =>
      loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_OAUTH_ENABLED: "true" }, "/tmp"),
    ).toThrow("MCP_OAUTH_APPROVAL_KEY");

    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "secret",
        MCP_OAUTH_ENABLED: "true",
        MCP_OAUTH_APPROVAL_KEY: "operator-approval-key",
        MCP_PUBLIC_URL: "https://mcp.example.com",
        MCP_OAUTH_STATE_FILE: "/tmp/oauth-state.json",
      },
      "/tmp",
    );
    expect(config).toMatchObject({
      oauthEnabled: true,
      oauthApprovalKey: "operator-approval-key",
      oauthIssuerUrl: "https://mcp.example.com/",
      oauthResourceUrl: "https://mcp.example.com/mcp",
      oauthStateFile: "/tmp/oauth-state.json",
    });
  });

  it("supports OAuth-only authentication with a separate approval key", () => {
    const config = loadConfig(
      {
        MCP_OAUTH_ENABLED: "true",
        MCP_OAUTH_APPROVAL_KEY: "separate-oauth-approval-key",
        MCP_PUBLIC_URL: "https://mcp.example.com",
        MCP_TRUST_PROXY_HOPS: "1",
      },
      "/tmp",
    );

    expect(config).toMatchObject({
      authToken: undefined,
      oauthApprovalKey: "separate-oauth-approval-key",
      trustProxyHops: 1,
    });
    expect(() =>
      loadConfig(
        {
          MCP_OAUTH_ENABLED: "true",
          MCP_PUBLIC_URL: "https://mcp.example.com",
        },
        "/tmp",
      ),
    ).toThrow("MCP_OAUTH_APPROVAL_KEY");
  });

  it("rejects unsafe proxy trust and OAuth URL settings", () => {
    expect(() =>
      loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_TRUST_PROXY_HOPS: "17" }, "/tmp"),
    ).toThrow("MCP_TRUST_PROXY_HOPS must be an integer between 0 and 16");
    expect(() =>
      loadConfig(
        {
          MCP_AUTH_TOKEN: "secret",
          MCP_OAUTH_ENABLED: "true",
          MCP_OAUTH_APPROVAL_KEY: "operator-key",
          MCP_OAUTH_ISSUER: "https://user:password@mcp.example.com",
          MCP_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
        },
        "/tmp",
      ),
    ).toThrow("must not contain user credentials");
  });

  it("requires a distinct operator approval key when OAuth and static auth coexist", () => {
    expect(() =>
      loadConfig(
        {
          MCP_AUTH_TOKEN: "same-secret",
          MCP_OAUTH_ENABLED: "true",
          MCP_OAUTH_APPROVAL_KEY: "same-secret",
          MCP_PUBLIC_URL: "https://mcp.example.com",
        },
        "/tmp",
      ),
    ).toThrow("must be different from MCP_AUTH_TOKEN");
  });

  it("parses only absolute bounded executable pins", () => {
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "secret",
        MCP_BOUNDED_EXECUTABLE_PATHS_JSON: '{"node":"/usr/bin/node","git":"/usr/bin/git"}',
      },
      "/tmp",
    );
    expect(config.boundedExecutablePaths).toEqual({
      node: "/usr/bin/node",
      git: "/usr/bin/git",
    });
    expect(() =>
      loadConfig(
        {
          MCP_AUTH_TOKEN: "secret",
          MCP_BOUNDED_EXECUTABLE_PATHS_JSON: '{"node":"./node"}',
        },
        "/tmp",
      ),
    ).toThrow("values must be absolute paths");
  });
});


describe("AgentCore broker configuration", () => {
  it("is disabled when no device keys are configured", () => {
    const config = loadConfig({ MCP_AUTH_TOKEN: "secret" }, "/tmp");
    expect(config.agentcoreDeviceKeys).toEqual({});
    expect(config.agentcoreDeviceStaleMs).toBe(90_000);
    expect(config.agentcoreJobTtlMs).toBe(15 * 60_000);
  });

  it("loads bounded per-device secrets without exposing defaults", () => {
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "secret",
        MCP_AGENTCORE_DEVICE_KEYS_JSON:
          '{"vicMac.local":"0123456789abcdef","m":"fedcba9876543210"}',
        MCP_AGENTCORE_DEVICE_STALE_MS: "120000",
        MCP_AGENTCORE_JOB_TTL_MS: "600000",
      },
      "/tmp",
    );
    expect(config.agentcoreDeviceKeys).toEqual({
      "vicMac.local": "0123456789abcdef",
      m: "fedcba9876543210",
    });
    expect(config.agentcoreDeviceStaleMs).toBe(120_000);
    expect(config.agentcoreJobTtlMs).toBe(600_000);
  });

  it("rejects malformed or weak device-key configuration", () => {
    expect(() =>
      loadConfig(
        { MCP_AUTH_TOKEN: "secret", MCP_AGENTCORE_DEVICE_KEYS_JSON: "not-json" },
        "/tmp",
      ),
    ).toThrow("must be valid JSON");
    expect(() =>
      loadConfig(
        {
          MCP_AUTH_TOKEN: "secret",
          MCP_AGENTCORE_DEVICE_KEYS_JSON: '{"vicMac.local":"short"}',
        },
        "/tmp",
      ),
    ).toThrow("between 16 and 512");
  });
});
