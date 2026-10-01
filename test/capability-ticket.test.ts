import { generateKeyPairSync, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { CapabilityGrant, CapabilityRequest } from "../src/capability-policy.js";
import {
  CapabilityTicketReplayGuard,
  actionDigest,
  issueCapabilityTicket,
  verifyCapabilityTicket,
} from "../src/capability-ticket.js";

const now = 1_000_000;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const request: CapabilityRequest = {
  capability: "tradingview.cdp",
  subjectId: "oauth-client-chatgpt",
  providerLabel: "chatgpt",
  projectId: "vic-tvauto",
  networkTarget: "127.0.0.1:9229",
};

function grant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    grantId: "grant-1",
    issuedBy: "human",
    approvalChannel: "local-ui",
    subjectId: request.subjectId,
    providerLabel: "chatgpt",
    projectId: request.projectId,
    capabilities: ["tradingview.cdp"],
    networkTargets: ["127.0.0.1:9229"],
    issuedAt: now - 1000,
    expiresAt: now + 60_000,
    maxUses: 10,
    uses: 1,
    ...overrides,
  };
}

describe("capability execution tickets", () => {
  it("signs and verifies an exact bounded host action", () => {
    const ticket = issueCapabilityTicket({
      grant: grant(),
      request,
      privateKey,
      ticketId: randomUUID(),
      now,
      ttlMs: 30_000,
    });
    const payload = verifyCapabilityTicket({
      ticket,
      request,
      publicKey,
      now: now + 1,
    });
    expect(payload.grantId).toBe("grant-1");
    expect(payload.actionDigest).toBe(actionDigest(request));
    expect(payload.expiresAt).toBe(now + 30_000);
  });

  it("rejects a changed target even with a valid signature", () => {
    const ticket = issueCapabilityTicket({
      grant: grant(),
      request,
      privateKey,
      ticketId: randomUUID(),
      now,
    });
    expect(() => verifyCapabilityTicket({
      ticket,
      request: { ...request, networkTarget: "127.0.0.1:9999" },
      publicKey,
      now: now + 1,
    })).toThrow(/does not match/);
  });

  it("rejects signature tampering", () => {
    const ticket = issueCapabilityTicket({
      grant: grant(),
      request,
      privateKey,
      ticketId: randomUUID(),
      now,
    });
    const parts = ticket.split(".");
    const payload = parts[0]!;
    const signature = parts[1]!;
    const altered = `${payload}.${signature.slice(0, -1)}A`;
    expect(() => verifyCapabilityTicket({
      ticket: altered,
      request,
      publicKey,
      now: now + 1,
    })).toThrow(/signature/);
  });

  it("rejects expired tickets", () => {
    const ticket = issueCapabilityTicket({
      grant: grant(),
      request,
      privateKey,
      ticketId: randomUUID(),
      now,
      ttlMs: 10,
    });
    expect(() => verifyCapabilityTicket({
      ticket,
      request,
      publicKey,
      now: now + 10,
    })).toThrow(/expired/);
  });

  it("rejects a grant that does not cover the action", () => {
    expect(() => issueCapabilityTicket({
      grant: grant({ networkTargets: ["127.0.0.1:5300"] }),
      request,
      privateKey,
      ticketId: randomUUID(),
      now,
    })).toThrow(/does not cover/);
  });

  it("refuses ticket issuance for widened command argv", () => {
    const execRequest: CapabilityRequest = {
      capability: "host.exec",
      subjectId: request.subjectId,
      providerLabel: "chatgpt",
      projectId: request.projectId,
      path: "/Users/vicmac/DevMac/Biz/TVauto",
      command: { executable: "git", args: ["status", "--short"] },
    };
    const execGrant = grant({
      capabilities: ["host.exec"],
      networkTargets: undefined,
      paths: ["/Users/vicmac/DevMac/Biz/TVauto"],
      commands: ["git"],
      commandSpecs: [{ executable: "git", args: ["status", "--short"] }],
    });

    expect(() => issueCapabilityTicket({
      grant: execGrant,
      request: {
        ...execRequest,
        command: { executable: "git", args: ["-C", "/tmp", "status"] },
      },
      privateKey,
      ticketId: randomUUID(),
      now,
    })).toThrow(/does not cover/);
  });

  it("prevents ticket replay at the host boundary", () => {
    const ticket = issueCapabilityTicket({
      grant: grant(),
      request,
      privateKey,
      ticketId: randomUUID(),
      now,
    });
    const payload = verifyCapabilityTicket({
      ticket,
      request,
      publicKey,
      now: now + 1,
    });
    const guard = new CapabilityTicketReplayGuard();
    guard.consume(payload.ticketId, payload.expiresAt, now + 1);
    expect(() => guard.consume(payload.ticketId, payload.expiresAt, now + 2)).toThrow(/replay/);
  });
});
