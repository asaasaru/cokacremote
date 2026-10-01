import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices, type McpServices } from "../src/mcp-server.js";

describe.sequential("trusted backend health HTTP flow", () => {
  let root: string;
  let running: RunningHttpServer;
  let services: McpServices;
  let baseUrl: URL;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cokacremote-health-e2e-"));
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "mcp-client-secret",
        MCP_BACKEND_HEALTH_KEY: "health-reporter-secret",
        MCP_HOST: "127.0.0.1",
        MCP_DEFAULT_CWD: root,
      },
      root,
    );
    config.port = 0;
    services = createServices(config);
    running = await startHttpServer(config, services);
    const address = running.httpServer.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  });

  afterAll(async () => {
    await running?.close();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function report(body: Record<string, unknown>, key = "health-reporter-secret") {
    return fetch(new URL("/internal/backend-health", baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-coka-health-key": key,
      },
      body: JSON.stringify(body),
    });
  }

  it("rejects an invalid reporter key", async () => {
    const response = await report(
      { backend: "agentcore.native", ok: true },
      "wrong-key",
    );
    expect(response.status).toBe(401);
    expect(services.health.get("agentcore.native").status).toBe("UNKNOWN");
  });

  it("accepts verified external observations and updates circuit state", async () => {
    const response = await report({
      backend: "agentcore.antigravity",
      ok: false,
      errorCode: "SESSION_EXPIRED",
      message: "provider login required",
      observedAt: 1000,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      health: {
        backend: "agentcore.antigravity",
        status: "AUTH_REQUIRED",
        manualActionRequired: true,
      },
      circuit: {
        state: "OPEN",
        reason: "AUTH_REQUIRED",
      },
    });
    expect(services.health.get("agentcore.antigravity").status).toBe("AUTH_REQUIRED");
  });

  it("does not invent policy denial from an ambiguous 403", async () => {
    const response = await report({
      backend: "tv_bridge",
      ok: false,
      httpStatus: 403,
      message: "Forbidden",
      observedAt: 2000,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      health: { status: "DEGRADED" },
    });
  });

  it("does not let reporters override coka's own local health", async () => {
    const response = await report({
      backend: "coka_local",
      ok: false,
      errorCode: "UNAVAILABLE",
    });
    expect(response.status).toBe(400);
    expect(services.health.get("coka_local").status).toBe("HEALTHY");
  });
});

describe("backend health endpoint disabled by default", () => {
  it("returns not found when no dedicated reporter key is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cokacremote-health-disabled-"));
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "mcp-client-secret",
        MCP_HOST: "127.0.0.1",
        MCP_DEFAULT_CWD: root,
      },
      root,
    );
    config.port = 0;
    const running = await startHttpServer(config, createServices(config));
    const address = running.httpServer.address() as AddressInfo;
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/internal/backend-health`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-coka-health-key": "anything",
          },
          body: JSON.stringify({ backend: "agentcore.native", ok: true }),
        },
      );
      expect(response.status).toBe(404);
    } finally {
      await running.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
