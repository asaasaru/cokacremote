import { randomUUID } from "node:crypto";
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

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function structured(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

function errorText(result: ToolResult): string {
  return String(structured(result).error ?? "");
}

describe.sequential("bounded capability enforcement", () => {
  let root: string;
  let workspaceRoot: string;
  let running: RunningHttpServer;
  let services: McpServices;
  let client: Client;
  let baseUrl: URL;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cokacremote-bounded-e2e-"));
    workspaceRoot = `/work/sandbox/cokacremote-capability-e2e-${randomUUID()}`;

    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "bounded-client-secret",
        MCP_HOST: "127.0.0.1",
        MCP_DEFAULT_CWD: root,
        MCP_CAPABILITY_MODE: "bounded",
        MCP_CAPABILITY_PROFILE: "coka-base",
        MCP_CAPABILITY_PROJECT: "cokacremote-e2e",
      },
      root,
    );
    config.port = 0;
    config.oauthApprovalKey = "operator-approval-key";

    services = createServices(config);
    running = await startHttpServer(config, services);
    const address = running.httpServer.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}`);

    client = new Client({ name: "bounded-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(config.endpoint, baseUrl),
      {
        requestInit: {
          headers: { authorization: "Bearer bounded-client-secret" },
        },
      },
    );
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await running?.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  async function call(
    name: string,
    arguments_: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    return client.callTool({ name, arguments: arguments_ });
  }

  async function callError(
    name: string,
    arguments_: Record<string, unknown> = {},
  ): Promise<string> {
    const result = await call(name, arguments_);
    expect(result.isError, `${name} unexpectedly succeeded`).toBe(true);
    expect(errorText(result)).not.toBe("");
    return errorText(result);
  }

  async function requestAndApprove(
    arguments_: Record<string, unknown>,
    maxUses: number,
  ): Promise<string> {
    const requested = await call("request_capability", {
      profileId: "coka-base",
      projectId: "cokacremote-e2e",
      ...arguments_,
    });
    expect(requested.isError).not.toBe(true);
    const data = structured(requested);
    expect(data.decision).toBe("APPROVAL_REQUIRED");
    const requestId = String(data.requestId);

    const approved = await fetch(new URL(`/approvals/${requestId}`, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_key: "operator-approval-key",
        decision: "approve",
        ttl: "300000",
        max_uses: String(maxUses),
      }),
    });
    expect(approved.status).toBe(200);

    const status = await call("approval_status", { requestId });
    const statusData = structured(status);
    expect(statusData.status).toBe("approved");
    return String(statusData.grantId);
  }

  it("reports bounded enforcement accurately in health", async () => {
    const response = await fetch(new URL("/health", baseUrl));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      capabilityMode: "bounded",
      capabilityProfileId: "coka-base",
      capabilityProjectId: "cokacremote-e2e",
      unrestrictedHostAccess: false,
    });
  });

  it("blocks ambiguous shell and unsafe patch tools in bounded mode", async () => {
    expect(await callError("exec_command", {
      cmd: "printf blocked",
      workdir: root,
    })).toContain("disabled in bounded capability mode");

    expect(await callError("run_script", {
      runtime: "bash",
      script: "printf blocked",
      workdir: root,
    })).toContain("disabled in bounded capability mode");

    expect(await callError("apply_patch", {
      patch: "--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+x",
      cwd: root,
    })).toContain("disabled in bounded capability mode");
  });

  it("allows workspace-scoped file operations without a host grant", async () => {
    const directory = await call("make_directory", {
      path: workspaceRoot,
      recursive: true,
    });
    expect(directory.isError).not.toBe(true);

    const target = path.join(workspaceRoot, "bounded.txt");
    const written = await call("write_file", {
      path: target,
      content: "workspace-ok",
    });
    expect(written.isError).not.toBe(true);

    const read = await call("read_file", { path: target });
    expect(read.isError).not.toBe(true);
    expect(structured(read).content).toBe("workspace-ok");
  });

  it("requires and consumes an exact host write grant", async () => {
    const target = path.join(root, "host-write.txt");

    expect(await callError("write_file", {
      path: target,
      content: "blocked",
    })).toContain("Capability approval required");

    const grantId = await requestAndApprove(
      {
        capability: "host.write",
        path: target,
        reason: "bounded host write test",
      },
      1,
    );
    expect(services.approvalBroker.getGrant(grantId)?.uses).toBe(0);

    const written = await call("write_file", {
      path: target,
      content: "approved",
    });
    expect(written.isError).not.toBe(true);
    expect(services.approvalBroker.getGrant(grantId)?.uses).toBe(1);

    expect(await callError("write_file", {
      path: target,
      content: "second-write",
    })).toContain("Capability approval required");
  });

  it("binds exec_argv to exact cwd and argv while route preview remains grant-neutral", async () => {
    const exactArgs = ["-e", "process.stdout.write('bounded-exec-ok')"];
    const grantId = await requestAndApprove(
      {
        capability: "host.exec",
        path: root,
        commandExecutable: "node",
        commandArgs: exactArgs,
        reason: "bounded argv test",
      },
      2,
    );
    expect(services.approvalBroker.getGrant(grantId)?.uses).toBe(0);

    const route = await call("execution_route", {
      profileId: "coka-base",
      projectId: "cokacremote-e2e",
      capability: "host.exec",
      path: root,
      commandExecutable: "node",
      commandArgs: exactArgs,
      task: "project.exec",
      mode: "auto",
    });
    expect(route.isError).not.toBe(true);
    expect(structured(route).policy).toMatchObject({
      decision: "ALLOW",
      grantId,
      remainingUses: 2,
    });
    expect(services.approvalBroker.getGrant(grantId)?.uses).toBe(0);

    expect(await callError("exec_argv", {
      executable: "node",
      args: ["--version"],
      workdir: root,
    })).toContain("Capability approval required");
    expect(services.approvalBroker.getGrant(grantId)?.uses).toBe(0);

    const executed = await call("exec_argv", {
      executable: "node",
      args: exactArgs,
      workdir: root,
      yieldTimeMs: 3000,
    });
    expect(executed.isError).not.toBe(true);
    expect(structured(executed)).toMatchObject({
      completed: true,
      exitCode: 0,
      stdout: "bounded-exec-ok",
    });
    expect(services.approvalBroker.getGrant(grantId)?.uses).toBe(1);

    expect(await callError("exec_argv", {
      executable: "node",
      args: exactArgs,
      workdir: `${root}-outside`,
    })).toContain("Capability approval required");
    expect(services.approvalBroker.getGrant(grantId)?.uses).toBe(1);
  });
});
