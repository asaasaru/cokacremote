import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices, type McpServices } from "../src/mcp-server.js";

describe.sequential("AgentCore independent transport", () => {
  let root: string;
  let running: RunningHttpServer;
  let services: McpServices;
  let baseUrl: URL;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  const deviceHeaders = {
    "content-type": "application/json",
    "x-coka-agentcore-device": "vicMac.local",
    "x-coka-agentcore-key": "0123456789abcdef0123456789abcdef",
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cokacremote-agentcore-e2e-"));
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "mcp-client-secret",
        MCP_AGENTCORE_DEVICE_KEYS_JSON:
          '{"vicMac.local":"0123456789abcdef0123456789abcdef","m":"fedcba9876543210fedcba9876543210"}',
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

    const registration = await fetch(new URL("/internal/agentcore/register", baseUrl), {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({
        platform: "macos",
        version: "0.2.6-approved-skip",
        fingerprint: "mac-fingerprint",
        projects: [
          { projectId: "vic-tvauto", root: "/Users/vicmac/DevMac/Biz/TVauto" },
        ],
        backends: ["agentcore.native"],
      }),
    });
    expect(registration.status).toBe(200);

    client = new Client({ name: "agentcore-transport-e2e", version: "1.0.0" });
    transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      requestInit: { headers: { authorization: "Bearer mcp-client-secret" } },
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await running?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("registers through the dedicated device key and exposes non-secret readiness", async () => {
    const health = await fetch(new URL("/health", baseUrl));
    expect(await health.json()).toMatchObject({
      executionRouterReady: true,
      agentcoreBrokerReady: true,
      registeredAgentCoreDevices: 1,
    });

    const rejected = await fetch(new URL("/internal/agentcore/heartbeat", baseUrl), {
      method: "POST",
      headers: {
        ...deviceHeaders,
        "x-coka-agentcore-key": "wrong-key",
      },
      body: "{}",
    });
    expect(rejected.status).toBe(401);
  });

  it("queues an MCP execution_request and returns the AgentCore result without RDC", async () => {
    const action = {
      profileId: "pine-tvauto",
      projectId: "vic-tvauto",
      providerLabel: "chatgpt",
      capability: "host.read",
      path: "/Users/vicmac/DevMac/Biz/TVauto/config.yaml",
      task: "project.read",
      mode: "auto",
      reason: "independent transport E2E",
      instruction: "Return a safe canary fact only.",
      readOperation: "stat",
    };

    const approvalRequest = await client.callTool({
      name: "execution_request",
      arguments: action,
    });
    expect(approvalRequest.isError).not.toBe(true);
    const pendingBody = approvalRequest.structuredContent as Record<string, unknown>;
    expect(pendingBody.decision).toBe("APPROVAL_REQUIRED");
    const approvalRequestId = String(pendingBody.requestId);
    const pending = services.approvalBroker.getPending(approvalRequestId);
    expect(pending).toBeDefined();
    services.approvalBroker.approveFromTrustedChannel(approvalRequestId, {
      approvedBy: "integration-test",
      approvalChannel: "operator-cli",
      subjectId: String(pending?.request.subjectId),
      providerLabel: "chatgpt",
      projectId: "vic-tvauto",
      capabilities: ["host.read"],
      paths: ["/Users/vicmac/DevMac/Biz/TVauto/config.yaml"],
      ttlMs: 60_000,
      maxUses: 1,
    });

    const requested = await client.callTool({
      name: "execution_request",
      arguments: action,
    });
    expect(requested.isError).not.toBe(true);
    const body = requested.structuredContent as Record<string, unknown>;
    expect(body).toMatchObject({
      decision: "ROUTE",
      transportStatus: "queued",
      nextAction: "POLL_EXECUTION_STATUS",
      handoff: {
        backend: "agentcore.native",
        deviceId: "vicMac.local",
        nextAction: "AWAIT_AGENTCORE_RESULT",
      },
    });
    const requestId = String(body.transportRequestId);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);

    const poll = await fetch(new URL("/internal/agentcore/poll", baseUrl), {
      method: "POST",
      headers: deviceHeaders,
      body: "{}",
    });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({
      job: {
        requestId,
        deviceId: "vicMac.local",
        projectId: "vic-tvauto",
        status: "leased",
        instruction: "Return a safe canary fact only.",
      },
    });

    const executionPending = await client.callTool({
      name: "execution_status",
      arguments: { requestId },
    });
    expect(executionPending.structuredContent).toMatchObject({
      request: { requestId, status: "leased" },
      nextAction: "POLL_EXECUTION_STATUS",
    });

    const result = await fetch(new URL("/internal/agentcore/result", baseUrl), {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({
        requestId,
        status: "completed",
        result: {
          summary: "independent transport verified",
          facts: ["RDC not involved"],
          testsPassed: true,
          evidencePaths: ["agentcore-runtime/tmp/canary.json"],
        },
      }),
    });
    expect(result.status).toBe(200);

    const completed = await client.callTool({
      name: "execution_status",
      arguments: { requestId },
    });
    expect(completed.structuredContent).toMatchObject({
      request: {
        requestId,
        status: "completed",
        result: {
          summary: "independent transport verified",
          facts: ["RDC not involved"],
          testsPassed: true,
        },
      },
      nextAction: "COMPLETE",
    });
    expect(services.health.get("agentcore.native").status).toBe("HEALTHY");
  });
});

describe("AgentCore transport disabled by default", () => {
  it("does not expose the internal broker when no device keys are configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cokacremote-agentcore-disabled-"));
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "secret",
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
        `http://127.0.0.1:${address.port}/internal/agentcore/register`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-coka-agentcore-device": "vicMac.local",
            "x-coka-agentcore-key": "0123456789abcdef0123456789abcdef",
          },
          body: JSON.stringify({}),
        },
      );
      expect(response.status).toBe(404);
    } finally {
      await running.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
