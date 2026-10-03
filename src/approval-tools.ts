import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ApprovalBroker } from "./approval-broker.js";
import { assertBoundedExecutableConfigured } from "./bounded-executable.js";
import {
  CapabilityPolicyEngine,
  type Capability,
  type CapabilityRequest,
} from "./capability-policy.js";
import type { AppConfig } from "./config.js";
import { getPolicyProfile } from "./policy-profiles.js";
import { runTool } from "./tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";

const capabilitySchema = z.enum([
  "workspace.read",
  "workspace.write",
  "workspace.exec",
  "host.read",
  "host.write",
  "host.exec",
  "tradingview.app",
  "tradingview.cdp",
  "loopback.http",
  "package.install",
  "destructive.fs",
  "real_trading",
  "secrets.read",
  "docker.socket",
  "browser.personal_profile",
  "host.unrestricted",
]).describe("Bounded capability being requested or evaluated.");

function subjectId(extra: { authInfo?: { clientId?: string } }): string {
  const value = extra.authInfo?.clientId?.trim();
  if (!value) {
    throw new Error("Capability approval requires an authenticated MCP client identity");
  }
  return value;
}

function approvalUrl(config: AppConfig, requestId: string): string {
  return config.publicUrl
    ? `${config.publicUrl}/approvals/${encodeURIComponent(requestId)}`
    : `/approvals/${encodeURIComponent(requestId)}`;
}

export function registerApprovalTools(
  server: McpServer,
  config: AppConfig,
  broker: ApprovalBroker,
): void {
  const authMetadata = toolAuthMetadata(config);

  server.registerTool(
    "request_capability",
    {
      title: "Request bounded capability",
      description:
        "Evaluate a bounded capability request. Hard-denied actions remain denied. Approval-required actions create a pending request for a separate human-only approval surface; this tool cannot approve its own request.",
      inputSchema: {
        profileId: z.string().default("pine-tvauto").describe("Policy profile used to evaluate the request. Defaults to the bounded pine-tvauto profile."),
        projectId: z.string().min(1).max(128).describe("Stable project identifier the requested capability is bound to."),
        providerLabel: z.string().min(1).max(64).optional().describe("Optional human-readable provider label. Authorization is bound to the authenticated client ID, not this label."),
        capability: capabilitySchema,
        path: z.string().optional().describe("Exact host or workspace path involved in the requested capability, when applicable."),
        commandExecutable: z.string().regex(/^[A-Za-z0-9._+-]+$/).optional().describe("Bare executable name only; paths are rejected. The host bridge maps approved names to trusted binaries."),
        commandArgs: z.array(z.string().max(2000)).max(64).optional().describe("Exact argument vector to bind to an execution approval. Different arguments require a different approval."),
        networkTarget: z.string().optional().describe("Exact host:port target to constrain a network capability, when applicable."),
        reason: z.string().max(1000).optional().describe("Short explanation shown to the human operator for this capability request."),
      },
      annotations: TOOL_ANNOTATIONS.additiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async (
      {
        profileId,
        projectId,
        providerLabel,
        capability,
        path,
        commandExecutable,
        commandArgs,
        networkTarget,
        reason,
      },
      extra,
    ) =>
      runTool(() => {
        if (commandArgs?.length && !commandExecutable) {
          throw new Error("commandArgs requires commandExecutable");
        }
        assertBoundedExecutableConfigured(config, commandExecutable);
        const request: CapabilityRequest = {
          capability: capability as Capability,
          subjectId: subjectId(extra),
          providerLabel,
          projectId,
          path,
          command: commandExecutable ? { executable: commandExecutable, args: commandArgs ?? [] } : undefined,
          networkTarget,
          reason,
        };
        const profile = getPolicyProfile(profileId, config.capabilityHostRoots);
        const engine = new CapabilityPolicyEngine(profile, broker.activeGrants());
        const decision = engine.evaluate(request);

        if (decision.decision !== "APPROVAL_REQUIRED") {
          return {
            profileId,
            decision: decision.decision,
            reason: decision.reason,
            grantId: decision.grantId,
            remainingUses: decision.remainingUses,
          };
        }

        const pending = broker.requestApproval(request);
        return {
          profileId,
          decision: "APPROVAL_REQUIRED",
          reason: decision.reason,
          requestId: pending.requestId,
          expiresAt: pending.expiresAt,
          approvalUrl: approvalUrl(config, pending.requestId),
        };
      }),
  );

  server.registerTool(
    "approval_status",
    {
      title: "Read capability approval status",
      description: "Read the status of a capability request created by this authenticated MCP client.",
      inputSchema: {
        requestId: z.string().uuid().describe("Capability approval request ID returned by request_capability."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ requestId }, extra) =>
      runTool(() => {
        const pending = broker.getPending(requestId);
        if (!pending || pending.request.subjectId !== subjectId(extra)) {
          throw new Error("Unknown approval request");
        }
        return {
          requestId,
          status: pending.status,
          expiresAt: pending.expiresAt,
          grantId: pending.grantId,
        };
      }),
  );

  server.registerTool(
    "revoke_capability",
    {
      title: "Revoke own capability grant",
      description: "Revoke a capability grant owned by this authenticated MCP client. Revocation never grants new access.",
      inputSchema: {
        grantId: z.string().uuid().describe("Capability grant ID owned by the authenticated MCP client to revoke."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ grantId }, extra) =>
      runTool(() => {
        const grant = broker.revokeBySubject(grantId, subjectId(extra));
        return {
          grantId: grant.grantId,
          revokedAt: grant.revokedAt,
        };
      }),
  );
}
