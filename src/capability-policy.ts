import path from "node:path";

export type ProviderLabel = "chatgpt" | "claude" | "codex" | "hermes" | string;

export type Capability =
  | "workspace.read"
  | "workspace.write"
  | "workspace.exec"
  | "host.read"
  | "host.write"
  | "host.exec"
  | "tradingview.app"
  | "tradingview.cdp"
  | "loopback.http"
  | "package.install"
  | "destructive.fs"
  | "real_trading"
  | "secrets.read"
  | "docker.socket"
  | "browser.personal_profile"
  | "host.unrestricted";

export interface CommandSpec {
  executable: string;
  args?: string[];
}

export interface CapabilityRequest {
  capability: Capability;
  subjectId: string;
  providerLabel?: ProviderLabel;
  projectId: string;
  path?: string;
  command?: CommandSpec;
  networkTarget?: string;
  resource?: string;
  reason?: string;
}

export interface CapabilityRule {
  capability: Capability;
  paths?: string[];
  commands?: string[];
  networkTargets?: string[];
}

export interface PolicyProfile {
  id: string;
  alwaysAllow: CapabilityRule[];
  approvalRequired: CapabilityRule[];
  hardDeny: CapabilityRule[];
}

export interface CapabilityGrant {
  grantId: string;
  issuedBy: "human";
  approvalChannel: "local-ui" | "operator-cli" | "hardware";
  subjectId: string;
  providerLabel?: ProviderLabel;
  projectId: string;
  capabilities: Capability[];
  paths?: string[];
  commands?: string[];
  networkTargets?: string[];
  issuedAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revokedAt?: number;
}

export type PolicyDecisionKind = "ALLOW" | "APPROVAL_REQUIRED" | "DENY";

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
  grantId?: string;
  remainingUses?: number;
}

function normalizedAbsolute(input: string): string {
  return path.resolve(input);
}

function isWithin(candidate: string, root: string): boolean {
  const c = normalizedAbsolute(candidate);
  const r = normalizedAbsolute(root);
  const rel = path.relative(r, c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function commandName(spec: CommandSpec | undefined): string | undefined {
  return spec ? path.basename(spec.executable) : undefined;
}

function matchesConstraints(
  request: CapabilityRequest,
  rule: Pick<CapabilityRule, "paths" | "commands" | "networkTargets">,
): boolean {
  if (rule.paths && rule.paths.length > 0) {
    if (!request.path || !rule.paths.some((root) => isWithin(request.path!, root))) {
      return false;
    }
  }

  if (rule.commands && rule.commands.length > 0) {
    const executable = commandName(request.command);
    if (!executable || !rule.commands.includes(executable)) {
      return false;
    }
  }

  if (rule.networkTargets && rule.networkTargets.length > 0) {
    if (!request.networkTarget || !rule.networkTargets.includes(request.networkTarget)) {
      return false;
    }
  }

  return true;
}

function ruleMatches(request: CapabilityRequest, rule: CapabilityRule): boolean {
  return request.capability === rule.capability && matchesConstraints(request, rule);
}

function grantMatches(request: CapabilityRequest, grant: CapabilityGrant, now: number): boolean {
  if (grant.issuedBy !== "human" || grant.revokedAt !== undefined) {
    return false;
  }
  if (grant.subjectId !== request.subjectId || grant.projectId !== request.projectId) {
    return false;
  }
  if (
    grant.providerLabel !== undefined &&
    request.providerLabel !== undefined &&
    grant.providerLabel !== request.providerLabel
  ) {
    return false;
  }
  if (grant.expiresAt <= now || grant.uses >= grant.maxUses) {
    return false;
  }
  if (!grant.capabilities.includes(request.capability)) {
    return false;
  }
  return matchesConstraints(request, {
    paths: grant.paths,
    commands: grant.commands,
    networkTargets: grant.networkTargets,
  });
}

export class CapabilityPolicyEngine {
  constructor(
    private readonly profile: PolicyProfile,
    private readonly grants: CapabilityGrant[] = [],
  ) {}

  evaluate(request: CapabilityRequest, now = Date.now()): PolicyDecision {
    if (this.profile.hardDeny.some((rule) => ruleMatches(request, rule))) {
      return {
        decision: "DENY",
        reason: `Capability ${request.capability} is hard-denied by profile ${this.profile.id}`,
      };
    }

    if (this.profile.alwaysAllow.some((rule) => ruleMatches(request, rule))) {
      return {
        decision: "ALLOW",
        reason: `Capability ${request.capability} is always allowed by profile ${this.profile.id}`,
      };
    }

    const grant = this.grants.find((candidate) => grantMatches(request, candidate, now));
    if (grant) {
      grant.uses += 1;
      return {
        decision: "ALLOW",
        reason: "Matched active human-issued capability grant",
        grantId: grant.grantId,
        remainingUses: Math.max(0, grant.maxUses - grant.uses),
      };
    }

    if (this.profile.approvalRequired.some((rule) => ruleMatches(request, rule))) {
      return {
        decision: "APPROVAL_REQUIRED",
        reason: `Capability ${request.capability} requires an active human-issued grant`,
      };
    }

    return {
      decision: "DENY",
      reason: `No rule permits capability ${request.capability} under profile ${this.profile.id}`,
    };
  }
}

export function revokeGrant(grant: CapabilityGrant, now = Date.now()): CapabilityGrant {
  grant.revokedAt = now;
  return grant;
}
