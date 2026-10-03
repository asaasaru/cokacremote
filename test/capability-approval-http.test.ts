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

describe.sequential("capability approval HTTP flow", () => {
  let root: string;
  let running: RunningHttpServer;
  let services: McpServices;
  let client: Client;
  let baseUrl: URL;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cokacremote-approval-e2e-"));
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "approval-client-secret",
        MCP_HOST: "127.0.0.1",
        MCP_DEFAULT_CWD: root,
      },
      root,
    );
    config.port = 0;
    config.oauthApprovalKey = "operator-approval-key";

    services = createServices(config);
    running = await startHttpServer(config, services);
    const address = running.httpServer.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}`);

    client = new Client({ name: "approval-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(config.endpoint, baseUrl),
      {
        requestInit: {
          headers: { authorization: "Bearer approval-client-secret" },
        },
      },
    );
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await running?.close();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a separate operator approval and consumes the bounded grant", async () => {
    const requested = await client.callTool({
      name: "request_capability",
      arguments: {
        profileId: "pine-tvauto",
        projectId: "vic-tvauto",
        providerLabel: "chatgpt",
        capability: "host.read",
        path: "/Users/vicmac/DevMac/Biz/TVauto/README.md",
        reason: "verify the bounded approval path",
      },
    });
    const requestData = requested.structuredContent as Record<string, unknown>;
    expect(requestData.decision).toBe("APPROVAL_REQUIRED");
    const requestId = String(requestData.requestId);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);

    const approvalPage = await fetch(new URL(`/approvals/${requestId}`, baseUrl));
    expect(approvalPage.status).toBe(200);
    const pageText = await approvalPage.text();
    expect(pageText).toContain("vic-tvauto");
    expect(pageText).toContain("host.read");

    const wrongKey = await fetch(new URL(`/approvals/${requestId}`, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_key: "wrong-key",
        decision: "approve",
        ttl: "300000",
        max_uses: "1",
      }),
    });
    expect(wrongKey.status).toBe(401);
    expect(services.approvalBroker.activeGrants()).toHaveLength(0);

    const approved = await fetch(new URL(`/approvals/${requestId}`, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_key: "operator-approval-key",
        decision: "approve",
        ttl: "300000",
        max_uses: "1",
      }),
    });
    expect(approved.status).toBe(200);
    expect(services.approvalBroker.activeGrants()).toHaveLength(1);

    const status = await client.callTool({
      name: "approval_status",
      arguments: { requestId },
    });
    const statusData = status.structuredContent as Record<string, unknown>;
    expect(statusData.status).toBe("approved");
    const grantId = String(statusData.grantId);
    expect(grantId).toMatch(/^[0-9a-f-]{36}$/i);

    const allowed = await client.callTool({
      name: "request_capability",
      arguments: {
        profileId: "pine-tvauto",
        projectId: "vic-tvauto",
        providerLabel: "chatgpt",
        capability: "host.read",
        path: "/Users/vicmac/DevMac/Biz/TVauto/README.md",
      },
    });
    expect(allowed.structuredContent).toMatchObject({
      decision: "ALLOW",
      grantId,
      remainingUses: 0,
    });

    const exhausted = await client.callTool({
      name: "request_capability",
      arguments: {
        profileId: "pine-tvauto",
        projectId: "vic-tvauto",
        providerLabel: "chatgpt",
        capability: "host.read",
        path: "/Users/vicmac/DevMac/Biz/TVauto/README.md",
      },
    });
    expect(exhausted.structuredContent).toMatchObject({
      decision: "APPROVAL_REQUIRED",
    });
  });

  it("consumes a one-use grant when an external execution handoff is issued", async () => {
    const args = {
      profileId: "pine-tvauto",
      projectId: "vic-tvauto",
      providerLabel: "chatgpt",
      capability: "host.read",
      path: "/Users/vicmac/DevMac/Biz/TVauto/README.md",
      task: "project.read",
      mode: "rdc",
      reason: "verify external handoff grant consumption",
    };

    const requested = await client.callTool({
      name: "execution_request",
      arguments: args,
    });
    const requestData = requested.structuredContent as Record<string, unknown>;
    expect(requestData.decision).toBe("APPROVAL_REQUIRED");
    const requestId = String(requestData.requestId);

    const approved = await fetch(new URL(`/approvals/${requestId}`, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_key: "operator-approval-key",
        decision: "approve",
        ttl: "300000",
        max_uses: "1",
      }),
    });
    expect(approved.status).toBe(200);
    expect(services.approvalBroker.activeGrants()).toHaveLength(1);

    const handedOff = await client.callTool({
      name: "execution_request",
      arguments: args,
    });
    expect(handedOff.structuredContent).toMatchObject({
      decision: "PROBE",
      handoff: {
        backend: "remote_desktop",
        nextAction: "INVOKE_REMOTE_DESKTOP",
        grantConsumption: "at_handoff_issuance",
      },
    });
    expect(services.approvalBroker.activeGrants()).toHaveLength(0);

    const exhausted = await client.callTool({
      name: "execution_request",
      arguments: args,
    });
    expect(exhausted.structuredContent).toMatchObject({
      decision: "APPROVAL_REQUIRED",
    });
  });

  it("warns the operator that an exec approval is not a kernel sandbox", async () => {
    const requested = await client.callTool({
      name: "request_capability",
      arguments: {
        profileId: "pine-tvauto",
        projectId: "vic-tvauto",
        providerLabel: "chatgpt",
        capability: "host.exec",
        path: "/Users/vicmac/DevMac/Biz/TVauto",
        commandExecutable: "python3",
        commandArgs: ["-m", "pytest", "-q"],
        reason: "verify execution approval warning",
      },
    });
    const data = requested.structuredContent as Record<string, unknown>;
    expect(data.decision).toBe("APPROVAL_REQUIRED");

    const page = await fetch(new URL(`/approvals/${String(data.requestId)}`, baseUrl));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("정확한 argv");
    expect(html).toContain("커널 수준으로 샌드박스");
  });

  it("fails closed on unknown approval decisions and never caches approval pages", async () => {
    const requested = await client.callTool({
      name: "request_capability",
      arguments: {
        profileId: "pine-tvauto",
        projectId: "vic-tvauto",
        providerLabel: "chatgpt",
        capability: "host.read",
        path: "/Users/vicmac/DevMac/Biz/TVauto/config.yaml",
        reason: "verify fail-closed approval form handling",
      },
    });
    const data = requested.structuredContent as Record<string, unknown>;
    expect(data.decision).toBe("APPROVAL_REQUIRED");
    const requestId = String(data.requestId);

    const page = await fetch(new URL(`/approvals/${requestId}`, baseUrl));
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");

    const malformed = await fetch(new URL(`/approvals/${requestId}`, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_key: "operator-approval-key",
        decision: "approve-anything",
        ttl: "300000",
        max_uses: "1",
      }),
    });
    expect(malformed.status).toBe(400);
    expect(services.approvalBroker.getPending(requestId)?.status).toBe("pending");
    expect(
      services.approvalBroker.activeGrants().some(
        (grant) => grant.projectId === "vic-tvauto" && grant.paths?.includes("/Users/vicmac/DevMac/Biz/TVauto/config.yaml"),
      ),
    ).toBe(false);
  });

  it("never turns a hard-denied request into an approval prompt", async () => {
    const denied = await client.callTool({
      name: "request_capability",
      arguments: {
        profileId: "pine-tvauto",
        projectId: "vic-tvauto",
        providerLabel: "chatgpt",
        capability: "secrets.read",
        reason: "must remain denied",
      },
    });
    const data = denied.structuredContent as Record<string, unknown>;
    expect(data.decision).toBe("DENY");
    expect(data.requestId).toBeUndefined();
  });
});
