import { describe, expect, it } from "vitest";

import { AgentCoreBroker } from "../src/agentcore-broker.js";

describe("AgentCoreBroker", () => {
  it("routes only active devices registered for the exact project/path", () => {
    const broker = new AgentCoreBroker(new Set(["vicMac.local", "m"]), 1_000, 10_000);
    broker.register(
      {
        deviceId: "vicMac.local",
        platform: "macos",
        version: "0.2.6-approved-skip",
        fingerprint: "mac-fingerprint",
        projects: [{ projectId: "vic-tvauto", root: "/Users/vicmac/DevMac/Biz/TVauto" }],
        backends: ["agentcore.native"],
      },
      100,
    );
    broker.register(
      {
        deviceId: "m",
        platform: "windows",
        version: "0.2.6-approved-skip",
        fingerprint: "win-fingerprint",
        projects: [{ projectId: "win-project", root: "F:\\DevF\\Biz\\Project" }],
        backends: ["agentcore.native"],
      },
      100,
    );

    expect(
      broker.canRoute(
        "agentcore.native",
        "vic-tvauto",
        "/Users/vicmac/DevMac/Biz/TVauto/config.yaml",
        500,
      ),
    ).toBe(true);
    expect(
      broker.canRoute("agentcore.native", "vic-tvauto", "/Users/vicmac/.ssh/config", 500),
    ).toBe(false);
    expect(
      broker.canRoute("agentcore.native", "win-project", "f:\\devf\\biz\\project\\README.md", 500),
    ).toBe(true);
    expect(broker.canRoute("agentcore.native", "vic-tvauto", undefined, 1_101)).toBe(false);
  });

  it("queues, leases, completes, and subject-binds jobs", () => {
    const broker = new AgentCoreBroker(new Set(["vicMac.local"]), 10_000, 10_000);
    broker.register(
      {
        deviceId: "vicMac.local",
        platform: "macos",
        version: "0.2.6-approved-skip",
        fingerprint: "mac-fingerprint",
        projects: [{ projectId: "vic-tvauto", root: "/Users/vicmac/DevMac/Biz/TVauto" }],
        backends: ["agentcore.native"],
      },
      100,
    );

    const queued = broker.enqueue(
      {
        subjectId: "client-a",
        backend: "agentcore.native",
        projectId: "vic-tvauto",
        task: "project.read",
        capability: "host.read",
        path: "/Users/vicmac/DevMac/Biz/TVauto/config.yaml",
        actionDigest: "digest",
        probeRequired: false,
        instruction: "Verify config.yaml exists.",
      },
      200,
    );
    expect(queued.status).toBe("queued");
    expect(broker.getForSubject(queued.requestId, "client-b", 250)).toBeUndefined();

    const leased = broker.poll("vicMac.local", 300);
    expect(leased).toMatchObject({ requestId: queued.requestId, status: "leased" });

    const completed = broker.complete(
      "vicMac.local",
      queued.requestId,
      "completed",
      {
        summary: "verified",
        facts: ["config.yaml present"],
        testsPassed: true,
      },
      400,
    );
    expect(completed).toMatchObject({
      status: "completed",
      result: { summary: "verified", testsPassed: true },
    });
    expect(broker.getForSubject(queued.requestId, "client-a", 500)).toMatchObject({
      status: "completed",
    });
  });
});
