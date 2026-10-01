import type { ApprovalBroker } from "./approval-broker.js";
import {
  CapabilityPolicyEngine,
  type Capability,
  type CapabilityRequest,
  type CommandSpec,
  type PolicyDecision,
} from "./capability-policy.js";
import type { AppConfig } from "./config.js";
import { getPolicyProfile } from "./policy-profiles.js";

export interface ToolAuthExtra {
  authInfo?: {
    clientId?: string;
  };
}

function subjectId(extra: ToolAuthExtra): string {
  const value = extra.authInfo?.clientId?.trim();
  if (!value) {
    throw new Error("Bounded capability mode requires an authenticated MCP client identity");
  }
  return value;
}

export class CapabilityGate {
  private readonly sessionOwners = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly broker: ApprovalBroker,
  ) {}

  isBounded(): boolean {
    return this.config.capabilityMode === "bounded";
  }

  private request(
    extra: ToolAuthExtra,
    capability: Capability,
    options: {
      path?: string;
      command?: CommandSpec;
      networkTarget?: string;
    } = {},
  ): CapabilityRequest {
    return {
      capability,
      subjectId: subjectId(extra),
      projectId: this.config.capabilityProjectId,
      path: options.path,
      command: options.command,
      networkTarget: options.networkTarget,
    };
  }

  private evaluate(request: CapabilityRequest, consume: boolean): PolicyDecision {
    const profile = getPolicyProfile(this.config.capabilityProfileId);
    const engine = new CapabilityPolicyEngine(profile, this.broker.activeGrants());
    return consume ? engine.evaluate(request) : engine.evaluatePreview(request);
  }

  private authorizeOneOf(
    extra: ToolAuthExtra,
    capabilities: Capability[],
    options: {
      path?: string;
      command?: CommandSpec;
      networkTarget?: string;
    } = {},
  ): PolicyDecision | undefined {
    if (!this.isBounded()) {
      return undefined;
    }

    const previews = capabilities.map((capability) => {
      const request = this.request(extra, capability, options);
      return { request, decision: this.evaluate(request, false) };
    });

    const allowed = previews.find(({ decision }) => decision.decision === "ALLOW");
    if (allowed) {
      return this.evaluate(allowed.request, true);
    }

    const approval = previews.find(
      ({ decision }) => decision.decision === "APPROVAL_REQUIRED",
    );
    if (approval) {
      throw new Error(
        `Capability approval required: ${approval.request.capability} (${approval.decision.reason})`,
      );
    }

    throw new Error(
      `Capability denied for ${capabilities.join(" or ")}: ${previews
        .map(({ decision }) => decision.reason)
        .join("; ")}`,
    );
  }

  authorizeRead(extra: ToolAuthExtra, path: string): PolicyDecision | undefined {
    return this.authorizeOneOf(extra, ["workspace.read", "host.read"], { path });
  }

  authorizeWrite(extra: ToolAuthExtra, path: string): PolicyDecision | undefined {
    return this.authorizeOneOf(extra, ["workspace.write", "host.write"], { path });
  }

  authorizeDestructive(extra: ToolAuthExtra, path: string): PolicyDecision | undefined {
    return this.authorizeOneOf(extra, ["workspace.write", "destructive.fs"], { path });
  }

  authorizeExec(
    extra: ToolAuthExtra,
    path: string,
    command: CommandSpec,
  ): PolicyDecision | undefined {
    return this.authorizeOneOf(extra, ["workspace.exec", "host.exec"], {
      path,
      command,
    });
  }

  blockUnsafeShell(toolName: string): void {
    if (this.isBounded()) {
      throw new Error(
        `${toolName} is disabled in bounded capability mode; use exec_argv with an exact executable and argument vector`,
      );
    }
  }

  blockUnsafePatch(): void {
    if (this.isBounded()) {
      throw new Error(
        "apply_patch is disabled in bounded capability mode because a patch may address paths outside the approved root; use exact file tools instead",
      );
    }
  }

  registerSession(extra: ToolAuthExtra, sessionId: string): void {
    if (!this.isBounded()) {
      return;
    }
    this.sessionOwners.set(sessionId, subjectId(extra));
  }

  assertSessionOwner(extra: ToolAuthExtra, sessionId: string): void {
    if (!this.isBounded()) {
      return;
    }
    const owner = this.sessionOwners.get(sessionId);
    if (!owner || owner !== subjectId(extra)) {
      throw new Error("Unknown process session");
    }
  }

  visibleSessionIds(extra: ToolAuthExtra): Set<string> | undefined {
    if (!this.isBounded()) {
      return undefined;
    }
    const subject = subjectId(extra);
    return new Set(
      [...this.sessionOwners.entries()]
        .filter(([, owner]) => owner === subject)
        .map(([sessionId]) => sessionId),
    );
  }
}
