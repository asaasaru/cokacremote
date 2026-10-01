import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ApprovalBroker } from "./approval-broker.js";
import {
  CapabilityPolicyEngine,
  type Capability,
  type CapabilityRequest,
} from "./capability-policy.js";
import {
  BackendHealthRegistry,
  type BackendId,
} from "./backend-health.js";
import { BackendCircuitBreaker } from "./circuit-breaker.js";
import { actionDigest } from "./capability-ticket.js";
import type { AppConfig } from "./config.js";
import { EXECUTION_ADAPTERS, type ExecutionTaskKind } from "./execution-adapters.js";
import { ExecutionRouter } from "./execution-router.js";
import {
  FallbackPolicy,
  type ExecutionMode,
} from "./fallback-policy.js";
import { getPolicyProfile } from "./policy-profiles.js";
import { RecoveryWorkflow } from "./recovery-workflow.js";
import { runTool } from "./tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";

const backendSchema = z.enum([
  "agentcore.antigravity",
  "agentcore.native",
  "remote_desktop",
  "tv_bridge",
  "coka_local",
]);

const taskSchema = z.enum([
  "project.read",
  "project.write",
  "project.test",
  "project.exec",
  "agentcore.canary",
  "agentcore.repair",
  "tradingview.compile",
  "tradingview.backtest",
  "tradingview.gui",
  "coka.sandbox",
]);

const modeSchema = z.enum(["auto", "cpaa", "rdc", "tvbridge", "local"]);

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
]);

function subjectId(extra: { authInfo?: { clientId?: string } }): string {
  const value = extra.authInfo?.clientId?.trim();
  if (!value) {
    throw new Error("Execution routing requires an authenticated MCP client identity");
  }
  return value;
}

function approvalUrl(config: AppConfig, requestId: string): string {
  return config.publicUrl
    ? `${config.publicUrl}/approvals/${encodeURIComponent(requestId)}`
    : `/approvals/${encodeURIComponent(requestId)}`;
}

function nextActionForBackend(backend: BackendId): string {
  if (backend === "coka_local") {
    return "EXECUTE_COKA_LOCAL";
  }
  if (backend === "remote_desktop") {
    return "INVOKE_REMOTE_DESKTOP";
  }
  if (backend === "tv_bridge") {
    return "INVOKE_TV_BRIDGE";
  }
  return "INVOKE_AGENTCORE";
}

export interface ExecutionToolServices {
  health: BackendHealthRegistry;
  circuits: BackendCircuitBreaker;
  fallback: FallbackPolicy;
  recovery: RecoveryWorkflow;
}

export function registerExecutionTools(
  server: McpServer,
  config: AppConfig,
  broker: ApprovalBroker,
  services: ExecutionToolServices,
): void {
  const authMetadata = toolAuthMetadata(config);

  server.registerTool(
    "execution_status",
    {
      title: "Read execution backend status",
      description:
        "Read verified backend health, circuit state, and adapter capabilities. This tool is read-only and cannot mark a backend healthy.",
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async () =>
      runTool(() => ({
        backends: services.health.list().map((record) => ({
          ...record,
          circuit: services.circuits.snapshot(record.backend),
          adapter: EXECUTION_ADAPTERS[record.backend],
        })),
      })),
  );

  server.registerTool(
    "execution_route",
    {
      title: "Plan a policy-safe execution route",
      description:
        "Evaluate the authenticated caller against the capability policy, then select an eligible backend from verified health. It never creates approvals, executes work, or lets callers self-report backend health.",
      inputSchema: {
        profileId: z.string().default("pine-tvauto").describe("Capability policy profile used before any backend is selected."),
        projectId: z.string().min(1).max(128).describe("Stable project identifier bound to the capability decision."),
        providerLabel: z.string().min(1).max(64).optional().describe("Optional human-readable provider label; authorization uses the authenticated client identity."),
        capability: capabilitySchema.describe("Bounded capability to evaluate before routing."),
        path: z.string().optional().describe("Exact host or workspace path involved in the capability request, when applicable."),
        commandExecutable: z.string().regex(/^[A-Za-z0-9._+-]+$/).optional().describe("Bare executable name for an exact bounded command request, when applicable."),
        commandArgs: z.array(z.string().max(2000)).max(64).optional().describe("Exact argument vector bound to commandExecutable."),
        networkTarget: z.string().optional().describe("Exact host:port target involved in the capability request, when applicable."),
        task: taskSchema.describe("Logical execution task used to select an eligible backend."),
        mode: modeSchema.default("auto").describe("Optional route restriction: auto, cpaa, rdc, tvbridge, or local."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
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
        task,
        mode,
      },
      extra,
    ) =>
      runTool(() => {
        if (commandArgs?.length && !commandExecutable) {
          throw new Error("commandArgs requires commandExecutable");
        }

        const request: CapabilityRequest = {
          capability: capability as Capability,
          subjectId: subjectId(extra),
          providerLabel,
          projectId,
          path,
          command: commandExecutable
            ? { executable: commandExecutable, args: commandArgs ?? [] }
            : undefined,
          networkTarget,
        };
        const profile = getPolicyProfile(profileId);
        const policy = new CapabilityPolicyEngine(profile, broker.activeGrants()).evaluatePreview(request);
        const router = new ExecutionRouter(
          services.health,
          services.circuits,
          services.fallback,
        );
        const route = router.route({
          task: task as ExecutionTaskKind,
          mode: mode as ExecutionMode,
          policyDecision: policy.decision,
        });
        return {
          profileId,
          policy: {
            decision: policy.decision,
            reason: policy.reason,
            grantId: policy.grantId,
            remainingUses: policy.remainingUses,
          },
          route,
        };
      }),
  );

  server.registerTool(
    "execution_request",
    {
      title: "Request or hand off bounded execution",
      description:
        "Combine capability evaluation, human approval creation, and backend routing. If approval is required, return the human-only approval URL. If allowed, return a bounded handoff envelope for the selected executor. UNKNOWN backend health produces a one-shot PROBE handoff rather than being treated as offline.",
      inputSchema: {
        profileId: z.string().default("pine-tvauto").describe("Capability policy profile used before execution."),
        projectId: z.string().min(1).max(128).describe("Stable project identifier bound to the capability decision."),
        providerLabel: z.string().min(1).max(64).optional().describe("Optional human-readable provider label."),
        capability: capabilitySchema.describe("Bounded capability requested for this exact action."),
        path: z.string().optional().describe("Exact path involved in the action, when applicable."),
        commandExecutable: z.string().regex(/^[A-Za-z0-9._+-]+$/).optional().describe("Bare executable name for an exact command approval."),
        commandArgs: z.array(z.string().max(2000)).max(64).optional().describe("Exact argv bound to the approval."),
        networkTarget: z.string().optional().describe("Exact host:port target, when applicable."),
        task: taskSchema.describe("Logical execution task."),
        mode: modeSchema.default("auto").describe("Route restriction: auto, cpaa, rdc, tvbridge, or local."),
        reason: z.string().max(1000).optional().describe("Short reason shown to the human approver."),
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
        task,
        mode,
        reason,
      },
      extra,
    ) =>
      runTool(() => {
        if (commandArgs?.length && !commandExecutable) {
          throw new Error("commandArgs requires commandExecutable");
        }

        const request: CapabilityRequest = {
          capability: capability as Capability,
          subjectId: subjectId(extra),
          providerLabel,
          projectId,
          path,
          command: commandExecutable
            ? { executable: commandExecutable, args: commandArgs ?? [] }
            : undefined,
          networkTarget,
          reason,
        };

        const profile = getPolicyProfile(profileId);
        const policy = new CapabilityPolicyEngine(
          profile,
          broker.activeGrants(),
        ).evaluatePreview(request);

        if (policy.decision === "DENY") {
          return {
            decision: "BLOCKED_POLICY",
            profileId,
            policy,
            actionDigest: actionDigest(request),
          };
        }

        if (policy.decision === "APPROVAL_REQUIRED") {
          const pending = broker.requestApproval(request);
          return {
            decision: "APPROVAL_REQUIRED",
            profileId,
            policy,
            actionDigest: actionDigest(request),
            requestId: pending.requestId,
            expiresAt: pending.expiresAt,
            approvalUrl: approvalUrl(config, pending.requestId),
            nextAction: "AWAIT_HUMAN_APPROVAL",
          };
        }

        const router = new ExecutionRouter(
          services.health,
          services.circuits,
          services.fallback,
        );
        const route = router.route({
          task: task as ExecutionTaskKind,
          mode: mode as ExecutionMode,
          policyDecision: policy.decision,
        });

        if ((route.decision === "ROUTE" || route.decision === "PROBE") && route.backend) {
          const adapter = EXECUTION_ADAPTERS[route.backend];
          return {
            decision: route.decision,
            profileId,
            policy,
            route,
            handoff: {
              backend: route.backend,
              transport: adapter.transport,
              provider: adapter.provider,
              task,
              capability,
              path,
              command: request.command,
              networkTarget,
              actionDigest: actionDigest(request),
              probeRequired: route.decision === "PROBE",
              nextAction: nextActionForBackend(route.backend),
              grantConsumption: "at_executor_boundary",
            },
          };
        }

        return {
          decision: route.decision,
          profileId,
          policy,
          route,
          actionDigest: actionDigest(request),
        };
      }),
  );

  server.registerTool(
    "execution_recovery",
    {
      title: "Read backend recovery plan",
      description:
        "Read the deterministic recovery plan for a backend's current verified health state. It performs no repair and grants no capability.",
      inputSchema: {
        backend: backendSchema.describe("Backend whose current verified health and recovery plan should be read."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ backend }) =>
      runTool(() => {
        const record = services.health.get(backend as BackendId);
        return {
          health: record,
          circuit: services.circuits.snapshot(record.backend),
          recovery: services.recovery.plan(record),
        };
      }),
  );
}
