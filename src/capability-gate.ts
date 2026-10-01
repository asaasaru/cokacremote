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

interface AuthorizationOptions {
  path?: string;
  command?: CommandSpec;
  networkTarget?: string;
}

interface AuthorizationCheck {
  capabilities: Capability[];
  options?: AuthorizationOptions;
}

interface SelectedAuthorization {
  request: CapabilityRequest;
  decision: PolicyDecision;
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
    options: AuthorizationOptions = {},
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

  private selectAuthorization(
    extra: ToolAuthExtra,
    capabilities: Capability[],
    options: AuthorizationOptions = {},
  ): SelectedAuthorization {
    const previews = capabilities.map((capability) => {
      const request = this.request(extra, capability, options);
      return { request, decision: this.evaluate(request, false) };
    });

    const allowed = previews.find(({ decision }) => decision.decision === "ALLOW");
    if (allowed) {
      return allowed;
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

  private authorizeBatch(
    extra: ToolAuthExtra,
    checks: AuthorizationCheck[],
  ): PolicyDecision[] | undefined {
    if (!this.isBounded()) {
      return undefined;
    }

    const selected = checks.map((check) =>
      this.selectAuthorization(extra, check.capabilities, check.options),
    );

    const grantNeeds = new Map<string, { uses: number; remaining: number }>();
    for (const item of selected) {
      const grantId = item.decision.grantId;
      if (!grantId) {
        continue;
      }
      const remaining = item.decision.remainingUses ?? 0;
      const current = grantNeeds.get(grantId) ?? { uses: 0, remaining };
      current.uses += 1;
      current.remaining = Math.min(current.remaining, remaining);
      grantNeeds.set(grantId, current);
    }
    for (const [grantId, need] of grantNeeds) {
      if (need.uses > need.remaining) {
        throw new Error(
          `Capability approval required: grant ${grantId} has insufficient remaining uses for this atomic operation`,
        );
      }
    }

    return selected.map(({ request }) => this.evaluate(request, true));
  }

  private authorizeOneOf(
    extra: ToolAuthExtra,
    capabilities: Capability[],
    options: AuthorizationOptions = {},
  ): PolicyDecision | undefined {
    return this.authorizeBatch(extra, [{ capabilities, options }])?.[0];
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

  authorizeCopy(extra: ToolAuthExtra, sourcePath: string, destinationPath: string): void {
    this.authorizeBatch(extra, [
      {
        capabilities: ["workspace.read", "host.read"],
        options: { path: sourcePath },
      },
      {
        capabilities: ["workspace.write", "host.write"],
        options: { path: destinationPath },
      },
    ]);
  }

  authorizeMove(extra: ToolAuthExtra, sourcePath: string, destinationPath: string): void {
    this.authorizeBatch(extra, [
      {
        capabilities: ["workspace.write", "destructive.fs"],
        options: { path: sourcePath },
      },
      {
        capabilities: ["workspace.write", "host.write"],
        options: { path: destinationPath },
      },
    ]);
  }

  assertExactExecPayload(
    env: Record<string, string> | undefined,
    stdin: string | undefined,
  ): void {
    if (!this.isBounded()) {
      return;
    }
    if (env && Object.keys(env).length > 0) {
      throw new Error(
        "Custom environment variables are disabled for exec_argv in bounded capability mode because they are not part of the exact command grant",
      );
    }
    if (stdin !== undefined) {
      throw new Error(
        "Initial stdin is disabled for exec_argv in bounded capability mode because it is not part of the exact command grant",
      );
    }
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

  blockInteractiveStdin(): void {
    if (this.isBounded()) {
      throw new Error(
        "write_stdin is disabled in bounded capability mode because interactive input is not part of the exact command grant",
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
