import { describe, expect, it } from "vitest";

import {
  CapabilityPolicyEngine,
  type CapabilityGrant,
} from "../src/capability-policy.js";
import { ApprovalBroker } from "../src/approval-broker.js";
import { pineTvautoProfile } from "../src/policy-profiles.js";

const now = 1_000_000;
const subjectId = "oauth-client-chatgpt";
const providerLabel = "chatgpt";
const projectId = "vic-tvauto";

function grant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    grantId: "g1",
    issuedBy: "human",
    approvalChannel: "local-ui",
    subjectId,
    providerLabel,
    projectId,
    capabilities: ["host.read"],
    paths: ["/Users/vicmac/DevMac/Biz/TVauto"],
    issuedAt: now,
    expiresAt: now + 60_000,
    maxUses: 2,
    uses: 0,
    ...overrides,
  };
}

describe("CapabilityPolicyEngine", () => {
  it("always allows bounded sandbox reads", () => {
    const engine = new CapabilityPolicyEngine(pineTvautoProfile);
    expect(engine.evaluate({
      capability: "workspace.read",
      subjectId,
      providerLabel,
      projectId,
      path: "/work/sandbox/demo/README.md",
    }, now).decision).toBe("ALLOW");
  });

  it("requires approval for TVauto host access without a grant", () => {
    const engine = new CapabilityPolicyEngine(pineTvautoProfile);
    expect(engine.evaluate({
      capability: "host.read",
      subjectId,
      providerLabel,
      projectId,
      path: "/Users/vicmac/DevMac/Biz/TVauto/README.md",
    }, now).decision).toBe("APPROVAL_REQUIRED");
  });

  it("accepts a matching human grant and consumes uses", () => {
    const g = grant();
    const engine = new CapabilityPolicyEngine(pineTvautoProfile, [g]);
    const decision = engine.evaluate({
      capability: "host.read",
      subjectId,
      providerLabel,
      projectId,
      path: "/Users/vicmac/DevMac/Biz/TVauto/README.md",
    }, now);
    expect(decision.decision).toBe("ALLOW");
    expect(decision.grantId).toBe("g1");
    expect(decision.remainingUses).toBe(1);
    expect(g.uses).toBe(1);
  });

  it("does not allow a grant issued to another OAuth client", () => {
    const engine = new CapabilityPolicyEngine(
      pineTvautoProfile,
      [grant({ subjectId: "oauth-client-claude", providerLabel: "claude" })],
    );
    expect(engine.evaluate({
      capability: "host.read",
      subjectId,
      providerLabel,
      projectId,
      path: "/Users/vicmac/DevMac/Biz/TVauto/README.md",
    }, now).decision).toBe("APPROVAL_REQUIRED");
  });

  it("does not allow access outside the approved path", () => {
    const engine = new CapabilityPolicyEngine(pineTvautoProfile, [grant()]);
    expect(engine.evaluate({
      capability: "host.read",
      subjectId,
      providerLabel,
      projectId,
      path: "/Users/vicmac/.ssh/id_ed25519",
    }, now).decision).toBe("DENY");
  });

  it("hard-denies secrets and real trading even when a grant claims them", () => {
    const dangerous = grant({
      capabilities: ["secrets.read", "real_trading"],
      paths: undefined,
    });
    const engine = new CapabilityPolicyEngine(pineTvautoProfile, [dangerous]);
    expect(engine.evaluate({ capability: "secrets.read", subjectId, providerLabel, projectId }, now).decision).toBe("DENY");
    expect(engine.evaluate({ capability: "real_trading", subjectId, providerLabel, projectId }, now).decision).toBe("DENY");
  });

  it("requires exact loopback targets", () => {
    const g = grant({
      capabilities: ["loopback.http", "tradingview.cdp"],
      paths: undefined,
      networkTargets: ["127.0.0.1:5300", "127.0.0.1:9229"],
    });
    const engine = new CapabilityPolicyEngine(pineTvautoProfile, [g]);

    expect(engine.evaluate({
      capability: "loopback.http",
      subjectId,
      providerLabel,
      projectId,
      networkTarget: "127.0.0.1:5300",
    }, now).decision).toBe("ALLOW");

    expect(engine.evaluate({
      capability: "loopback.http",
      subjectId,
      providerLabel,
      projectId,
      networkTarget: "127.0.0.1:9999",
    }, now).decision).toBe("DENY");
  });

  it("limits TradingView CDP approval to the TVauto resilient port set", () => {
    const engine = new CapabilityPolicyEngine(pineTvautoProfile);
    for (const networkTarget of [
      "127.0.0.1:9229",
      "127.0.0.1:9333",
      "127.0.0.1:9222",
    ]) {
      expect(engine.evaluate({
        capability: "tradingview.cdp",
        subjectId,
        providerLabel,
        projectId,
        networkTarget,
      }, now).decision).toBe("APPROVAL_REQUIRED");
    }

    expect(engine.evaluate({
      capability: "tradingview.cdp",
      subjectId,
      providerLabel,
      projectId,
      networkTarget: "127.0.0.1:9444",
    }, now).decision).toBe("DENY");
  });

  it("rejects executable paths even when the basename is allowlisted", () => {
    const g = grant({
      capabilities: ["host.exec"],
      commands: ["git"],
      paths: ["/Users/vicmac/DevMac/Biz/TVauto"],
    });
    const engine = new CapabilityPolicyEngine(pineTvautoProfile, [g]);
    expect(engine.evaluate({
      capability: "host.exec",
      subjectId,
      providerLabel,
      projectId,
      path: "/Users/vicmac/DevMac/Biz/TVauto",
      command: { executable: "/tmp/git", args: ["status"] },
    }, now).decision).toBe("DENY");
  });

  it("binds an exec grant to the exact approved argv", () => {
    const g = grant({
      capabilities: ["host.exec"],
      commands: ["git"],
      commandSpecs: [{ executable: "git", args: ["status", "--short"] }],
      paths: ["/Users/vicmac/DevMac/Biz/TVauto"],
    });
    const engine = new CapabilityPolicyEngine(pineTvautoProfile, [g]);

    expect(engine.evaluate({
      capability: "host.exec",
      subjectId,
      providerLabel,
      projectId,
      path: "/Users/vicmac/DevMac/Biz/TVauto",
      command: { executable: "git", args: ["status", "--short"] },
    }, now).decision).toBe("ALLOW");

    expect(engine.evaluate({
      capability: "host.exec",
      subjectId,
      providerLabel,
      projectId,
      path: "/Users/vicmac/DevMac/Biz/TVauto",
      command: { executable: "git", args: ["-C", "/tmp", "status"] },
    }, now).decision).toBe("APPROVAL_REQUIRED");
  });

  it("rejects expired and exhausted grants", () => {
    const expired = grant({ expiresAt: now });
    const exhausted = grant({ grantId: "g2", uses: 2, maxUses: 2 });
    const engine = new CapabilityPolicyEngine(pineTvautoProfile, [expired, exhausted]);
    expect(engine.evaluate({
      capability: "host.read",
      subjectId,
      providerLabel,
      projectId,
      path: "/Users/vicmac/DevMac/Biz/TVauto/README.md",
    }, now).decision).toBe("APPROVAL_REQUIRED");
  });
});

describe("ApprovalBroker", () => {
  it("creates a subject/project-bound grant only through trusted approval API", () => {
    const broker = new ApprovalBroker(60_000, 600_000, 20);
    const pending = broker.requestApproval({
      capability: "tradingview.cdp",
      subjectId,
      providerLabel,
      projectId,
      networkTarget: "127.0.0.1:9229",
    }, now);

    const g = broker.approveFromTrustedChannel(pending.requestId, {
      approvedBy: "operator",
      approvalChannel: "local-ui",
      subjectId,
      providerLabel,
      projectId,
      capabilities: ["tradingview.cdp"],
      networkTargets: ["127.0.0.1:9229"],
      ttlMs: 300_000,
      maxUses: 10,
    }, now);

    expect(g.issuedBy).toBe("human");
    expect(g.subjectId).toBe(subjectId);
    expect(g.projectId).toBe(projectId);
    expect(g.expiresAt).toBe(now + 300_000);
    expect(broker.getPending(pending.requestId)?.status).toBe("approved");
  });

  it("cannot approve a request for a different OAuth client or project", () => {
    const broker = new ApprovalBroker();
    const pending = broker.requestApproval({
      capability: "host.exec",
      subjectId,
      providerLabel,
      projectId,
      path: "/Users/vicmac/DevMac/Biz/TVauto",
    }, now);

    expect(() => broker.approveFromTrustedChannel(pending.requestId, {
      approvedBy: "operator",
      approvalChannel: "operator-cli",
      subjectId: "oauth-client-claude",
      providerLabel: "claude",
      projectId,
      capabilities: ["host.exec"],
      paths: ["/Users/vicmac/DevMac/Biz/TVauto"],
      ttlMs: 1_000,
      maxUses: 1,
    }, now)).toThrow(/subject\/project/);
  });
});
