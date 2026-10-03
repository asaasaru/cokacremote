import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AgentCoreBackend, AgentCoreBroker } from "./agentcore-broker.js";
import { assertBoundedExecutableConfigured } from "./bounded-executable.js";
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
import {
  CONTROL_PLANE_CONTRACT_FINGERPRINT,
  CONTROL_PLANE_CONTRACT_REVISION,
  CONTROL_PLANE_SCHEMA_COMPATIBILITY,
  STABLE_CONTROL_PLANE_TOOLS,
} from "./tool-contract.js";

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

const readOperationSchema = z.enum(["stat", "sha256", "text", "git_status"]);

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

function parseSupportedValue<T extends string>(
  schema: z.ZodEnum<Record<string, T>>,
  value: string,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Unsupported ${label}: ${value}`);
  }
  return parsed.data;
}

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
  agentcoreBroker: AgentCoreBroker;
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
      inputSchema: {
        requestId: z.string().uuid().optional().describe("Optional AgentCore transport request ID returned by execution_request."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ requestId }, extra) =>
      runTool(() => {
        if (requestId) {
          const job = services.agentcoreBroker.getForSubject(requestId, subjectId(extra));
          if (!job) {
            throw new Error("Unknown execution request");
          }
          return {
            request: job,
            nextAction:
              job.status === "queued" || job.status === "leased"
                ? "POLL_EXECUTION_STATUS"
                : "COMPLETE",
          };
        }
        return {
          contract: {
            revision: CONTROL_PLANE_CONTRACT_REVISION,
            fingerprint: CONTROL_PLANE_CONTRACT_FINGERPRINT,
            stableTools: [...STABLE_CONTROL_PLANE_TOOLS],
            compatibility: CONTROL_PLANE_SCHEMA_COMPATIBILITY,
            supportedCapabilities: [...capabilitySchema.options],
            supportedTasks: [...taskSchema.options],
            supportedModes: [...modeSchema.options],
            supportedReadOperations: [...readOperationSchema.options],
          },
          backends: services.health.list().map((record) => ({
            ...record,
            circuit: services.circuits.snapshot(record.backend),
            adapter: EXECUTION_ADAPTERS[record.backend],
          })),
          agentcoreTransport: {
            enabled: services.agentcoreBroker.enabled(),
            activeDevices: services.agentcoreBroker.activeDevices().length,
          },
        };
      }),
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
        capability: z.string().min(1).max(64).describe("Capability identifier validated against the current server allowlist."),
        path: z.string().optional().describe("Exact host or workspace path involved in the capability request, when applicable."),
        commandExecutable: z.string().regex(/^[A-Za-z0-9._+-]+$/).optional().describe("Bare executable name for an exact bounded command request, when applicable."),
        commandArgs: z.array(z.string().max(2000)).max(64).optional().describe("Exact argument vector bound to commandExecutable."),
        networkTarget: z.string().optional().describe("Exact host:port target involved in the capability request, when applicable."),
        task: z.string().min(1).max(64).describe("Execution task identifier validated against the current server allowlist."),
        mode: z.string().min(1).max(32).default("auto").describe("Route-mode identifier validated against the current server allowlist."),
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
        assertBoundedExecutableConfigured(config, commandExecutable);
        const validatedCapability = parseSupportedValue(capabilitySchema, capability, "capability") as Capability;
        const validatedTask = parseSupportedValue(taskSchema, task, "task") as ExecutionTaskKind;
        const validatedMode = parseSupportedValue(modeSchema, mode, "mode") as ExecutionMode;

        const request: CapabilityRequest = {
          capability: validatedCapability,
          subjectId: subjectId(extra),
          providerLabel,
          projectId,
          path,
          command: commandExecutable
            ? { executable: commandExecutable, args: commandArgs ?? [] }
            : undefined,
          networkTarget,
        };
        const profile = getPolicyProfile(profileId, config.capabilityHostRoots);
        const policy = new CapabilityPolicyEngine(profile, broker.activeGrants()).evaluatePreview(request);
        const router = new ExecutionRouter(
          services.health,
          services.circuits,
          services.fallback,
        );
        const route = router.route({
          task: validatedTask,
          mode: validatedMode,
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
        capability: z.string().min(1).max(64).describe("Capability identifier validated against the current server allowlist."),
        path: z.string().optional().describe("Exact path involved in the action, when applicable."),
        commandExecutable: z.string().regex(/^[A-Za-z0-9._+-]+$/).optional().describe("Bare executable name for an exact command approval."),
        commandArgs: z.array(z.string().max(2000)).max(64).optional().describe("Exact argv bound to the approval."),
        networkTarget: z.string().optional().describe("Exact host:port target, when applicable."),
        task: z.string().min(1).max(64).describe("Execution task identifier validated against the current server allowlist."),
        mode: z.string().min(1).max(32).default("auto").describe("Route-mode identifier validated against the current server allowlist."),
        reason: z.string().max(1000).optional().describe("Short reason shown to the human approver."),
        planId: z.string().min(1).max(255).optional().describe("Canonical plan basename for AgentCore work."),
        planSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("SHA-256 of the canonical plan."),
        instruction: z.string().min(1).max(20_000).optional().describe("Bounded instruction delivered to AgentCore after policy approval."),
        testIds: z.array(z.string().min(1).max(256)).max(100).optional().describe("Approved AgentCore test IDs."),
        readOperation: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe("Read-operation identifier validated against the current server allowlist; valid only with task=project.read."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(65_536)
          .optional()
          .describe("Maximum text bytes returned by readOperation=text."),
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
        planId,
        planSha256,
        instruction,
        testIds,
        readOperation,
        maxBytes,
      },
      extra,
    ) =>
      runTool(() => {
        if (commandArgs?.length && !commandExecutable) {
          throw new Error("commandArgs requires commandExecutable");
        }
        assertBoundedExecutableConfigured(config, commandExecutable);
        const validatedCapability = parseSupportedValue(capabilitySchema, capability, "capability") as Capability;
        const validatedTask = parseSupportedValue(taskSchema, task, "task") as ExecutionTaskKind;
        const validatedMode = parseSupportedValue(modeSchema, mode, "mode") as ExecutionMode;
        const validatedReadOperation = readOperation
          ? parseSupportedValue(readOperationSchema, readOperation, "readOperation")
          : undefined;
        if ((planId && !planSha256) || (!planId && planSha256)) {
          throw new Error("planId and planSha256 must be provided together");
        }
        if (
          ["project.write", "project.test", "project.exec"].includes(validatedTask) &&
          (!planId || !planSha256 || !instruction)
        ) {
          throw new Error("Mutating AgentCore tasks require planId, planSha256, and instruction");
        }
        if (validatedReadOperation && validatedTask !== "project.read") {
          throw new Error("readOperation is valid only with task=project.read");
        }
        if (maxBytes && validatedReadOperation !== "text") {
          throw new Error("maxBytes is valid only with readOperation=text");
        }
        if (validatedTask === "project.read" && validatedReadOperation === "git_status" && !path) {
          throw new Error("git_status requires the approved project root path");
        }

        const request: CapabilityRequest = {
          capability: validatedCapability,
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

        const profile = getPolicyProfile(profileId, config.capabilityHostRoots);
        const policyEngine = new CapabilityPolicyEngine(
          profile,
          broker.activeGrants(),
        );
        const policy = policyEngine.evaluatePreview(request);

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
          task: validatedTask,
          mode: validatedMode,
          policyDecision: policy.decision,
        });

        if ((route.decision === "ROUTE" || route.decision === "PROBE") && route.backend) {
          const adapter = EXECUTION_ADAPTERS[route.backend];
          const externalHandoff = route.backend !== "coka_local";
          const agentcoreBackend =
            route.backend === "agentcore.native" || route.backend === "agentcore.antigravity"
              ? (route.backend as AgentCoreBackend)
              : undefined;

          if (
            agentcoreBackend &&
            services.agentcoreBroker.enabled() &&
            !services.agentcoreBroker.canRoute(agentcoreBackend, projectId, path)
          ) {
            return {
              decision: "TRANSPORT_UNAVAILABLE",
              profileId,
              policy,
              route,
              actionDigest: actionDigest(request),
              reason:
                "CONTROL_PLANE_TRANSPORT_MISSING: no active AgentCore device is registered for this project/path.",
              nextAction: "AWAIT_AGENTCORE_DEVICE",
            };
          }

          const handoffPolicy = externalHandoff
            ? policyEngine.evaluate(request)
            : policy;
          if (handoffPolicy.decision !== "ALLOW") {
            throw new Error("Capability became unavailable before external handoff issuance");
          }

          const baseHandoff = {
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
            grantConsumption: externalHandoff
              ? "at_handoff_issuance"
              : "at_executor_boundary",
          };

          if (agentcoreBackend && services.agentcoreBroker.enabled()) {
            const job = services.agentcoreBroker.enqueue({
              subjectId: request.subjectId,
              backend: agentcoreBackend,
              projectId,
              task: validatedTask,
              capability: validatedCapability,
              path,
              command: request.command
                ? { executable: request.command.executable, args: request.command.args ?? [] }
                : undefined,
              networkTarget,
              actionDigest: actionDigest(request),
              probeRequired: route.decision === "PROBE",
              planId,
              planSha256,
              instruction,
              testIds,
              readOperation: validatedReadOperation,
              maxBytes,
            });
            return {
              decision: route.decision,
              profileId,
              policy: handoffPolicy,
              route,
              transportRequestId: job.requestId,
              transportStatus: job.status,
              nextAction: "POLL_EXECUTION_STATUS",
              handoff: {
                ...baseHandoff,
                deviceId: job.deviceId,
                projectRoot: job.projectRoot,
                nextAction: "AWAIT_AGENTCORE_RESULT",
              },
            };
          }

          return {
            decision: route.decision,
            profileId,
            policy: handoffPolicy,
            route,
            handoff: baseHandoff,
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
