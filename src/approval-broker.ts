import { randomUUID } from "node:crypto";

import type {
  Capability,
  CapabilityGrant,
  CapabilityRequest,
  ProviderLabel,
} from "./capability-policy.js";

export interface PendingApproval {
  requestId: string;
  request: CapabilityRequest;
  requestedAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired";
  grantId?: string;
}

export interface HumanApprovalInput {
  approvedBy: string;
  approvalChannel: "local-ui" | "operator-cli" | "hardware";
  subjectId: string;
  providerLabel?: ProviderLabel;
  projectId: string;
  capabilities: Capability[];
  paths?: string[];
  commands?: string[];
  networkTargets?: string[];
  ttlMs: number;
  maxUses: number;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly grants = new Map<string, CapabilityGrant>();

  constructor(
    private readonly pendingTtlMs = 5 * 60_000,
    private readonly maxGrantTtlMs = 60 * 60_000,
    private readonly maxUsesPerGrant = 100,
  ) {}

  requestApproval(request: CapabilityRequest, now = Date.now()): PendingApproval {
    const requestId = randomUUID();
    const item: PendingApproval = {
      requestId,
      request,
      requestedAt: now,
      expiresAt: now + this.pendingTtlMs,
      status: "pending",
    };
    this.pending.set(requestId, item);
    return item;
  }

  approveFromTrustedChannel(
    requestId: string,
    input: HumanApprovalInput,
    now = Date.now(),
  ): CapabilityGrant {
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new Error("Unknown approval request");
    }
    if (pending.expiresAt <= now) {
      pending.status = "expired";
      throw new Error("Approval request expired");
    }
    if (pending.status !== "pending") {
      throw new Error(`Approval request is already ${pending.status}`);
    }
    if (
      input.subjectId !== pending.request.subjectId ||
      input.projectId !== pending.request.projectId
    ) {
      throw new Error("Approval subject/project must match the pending request");
    }
    if (
      input.providerLabel !== undefined &&
      pending.request.providerLabel !== undefined &&
      input.providerLabel !== pending.request.providerLabel
    ) {
      throw new Error("Approval provider label must match the pending request");
    }
    if (!input.capabilities.includes(pending.request.capability)) {
      throw new Error("Approval must include the requested capability");
    }
    if (!input.approvedBy.trim()) {
      throw new Error("approvedBy is required");
    }

    const ttlMs = Math.min(Math.max(1, input.ttlMs), this.maxGrantTtlMs);
    const maxUses = Math.min(Math.max(1, input.maxUses), this.maxUsesPerGrant);
    const grant: CapabilityGrant = {
      grantId: randomUUID(),
      issuedBy: "human",
      approvalChannel: input.approvalChannel,
      subjectId: input.subjectId,
      providerLabel: input.providerLabel,
      projectId: input.projectId,
      capabilities: [...new Set(input.capabilities)],
      paths: input.paths ? [...new Set(input.paths)] : undefined,
      commands: input.commands ? [...new Set(input.commands)] : undefined,
      networkTargets: input.networkTargets ? [...new Set(input.networkTargets)] : undefined,
      issuedAt: now,
      expiresAt: now + ttlMs,
      maxUses,
      uses: 0,
    };

    pending.status = "approved";
    pending.grantId = grant.grantId;
    this.grants.set(grant.grantId, grant);
    return grant;
  }

  denyFromTrustedChannel(requestId: string): PendingApproval {
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new Error("Unknown approval request");
    }
    if (pending.status !== "pending") {
      throw new Error(`Approval request is already ${pending.status}`);
    }
    pending.status = "denied";
    return pending;
  }

  revokeFromTrustedChannel(grantId: string, now = Date.now()): CapabilityGrant {
    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new Error("Unknown grant");
    }
    grant.revokedAt = now;
    return grant;
  }

  revokeBySubject(grantId: string, subjectId: string, now = Date.now()): CapabilityGrant {
    const grant = this.grants.get(grantId);
    if (!grant || grant.subjectId !== subjectId) {
      throw new Error("Unknown grant");
    }
    grant.revokedAt = now;
    return grant;
  }

  activeGrants(now = Date.now()): CapabilityGrant[] {
    return [...this.grants.values()].filter(
      (grant) => grant.revokedAt === undefined && grant.expiresAt > now && grant.uses < grant.maxUses,
    );
  }

  activeGrantsForSubject(subjectId: string, now = Date.now()): CapabilityGrant[] {
    return this.activeGrants(now).filter((grant) => grant.subjectId === subjectId);
  }

  getPending(requestId: string): PendingApproval | undefined {
    return this.pending.get(requestId);
  }

  getGrant(grantId: string): CapabilityGrant | undefined {
    return this.grants.get(grantId);
  }
}
