import type { PolicyDecisionKind } from "./capability-policy.js";
import {
  type BackendHealthRecord,
  type BackendHealthStatus,
  type BackendId,
  BackendHealthRegistry,
} from "./backend-health.js";
import { BackendCircuitBreaker } from "./circuit-breaker.js";
import type { ExecutionTaskKind } from "./execution-adapters.js";

export type ExecutionMode = "auto" | "cpaa" | "rdc" | "tvbridge" | "local";

export interface ExecutionRouteRequest {
  task: ExecutionTaskKind;
  mode?: ExecutionMode;
  policyDecision: PolicyDecisionKind;
}

export type RouteDecisionKind =
  | "ROUTE"
  | "APPROVAL_REQUIRED"
  | "BLOCKED_POLICY"
  | "UNAVAILABLE";

export interface SkippedRoute {
  backend: BackendId;
  status: BackendHealthStatus;
  reason: string;
}

export interface ExecutionRouteDecision {
  decision: RouteDecisionKind;
  backend?: BackendId;
  degraded?: boolean;
  reason: string;
  skipped: SkippedRoute[];
}

const AUTO_ROUTES: Record<ExecutionTaskKind, BackendId[]> = {
  "project.read": ["agentcore.antigravity", "agentcore.native", "remote_desktop"],
  "project.write": ["agentcore.antigravity", "agentcore.native", "remote_desktop"],
  "project.test": ["agentcore.antigravity", "agentcore.native", "remote_desktop"],
  "project.exec": ["agentcore.antigravity", "agentcore.native", "remote_desktop"],
  "agentcore.canary": ["agentcore.native", "remote_desktop"],
  "agentcore.repair": ["remote_desktop"],
  "tradingview.compile": ["tv_bridge", "agentcore.native", "remote_desktop"],
  "tradingview.backtest": ["tv_bridge", "agentcore.native", "remote_desktop"],
  "tradingview.gui": ["remote_desktop"],
  "coka.sandbox": ["coka_local"],
};

function forcedCandidates(task: ExecutionTaskKind, mode: ExecutionMode): BackendId[] {
  if (mode === "auto") {
    return AUTO_ROUTES[task];
  }
  if (mode === "cpaa") {
    return AUTO_ROUTES[task].filter((backend) => backend.startsWith("agentcore."));
  }
  if (mode === "rdc") {
    return AUTO_ROUTES[task].filter((backend) => backend === "remote_desktop");
  }
  if (mode === "tvbridge") {
    return AUTO_ROUTES[task].filter((backend) => backend === "tv_bridge");
  }
  return AUTO_ROUTES[task].filter((backend) => backend === "coka_local");
}

function skipReason(record: BackendHealthRecord, circuitAllowed: boolean): string {
  if (!circuitAllowed) {
    return `circuit open for ${record.backend}`;
  }
  return record.reason ?? `backend status is ${record.status}`;
}

export class ExecutionRouter {
  constructor(
    private readonly health: BackendHealthRegistry,
    private readonly circuits: BackendCircuitBreaker,
  ) {}

  route(request: ExecutionRouteRequest, now = Date.now()): ExecutionRouteDecision {
    if (request.policyDecision === "DENY") {
      return {
        decision: "BLOCKED_POLICY",
        reason: "Capability policy denied the action; executor fallback is prohibited.",
        skipped: [],
      };
    }
    if (request.policyDecision === "APPROVAL_REQUIRED") {
      return {
        decision: "APPROVAL_REQUIRED",
        reason: "Capability approval must be completed before executor selection.",
        skipped: [],
      };
    }

    const candidates = forcedCandidates(request.task, request.mode ?? "auto");
    if (candidates.length === 0) {
      return {
        decision: "UNAVAILABLE",
        reason: `Execution mode ${request.mode ?? "auto"} has no valid backend for ${request.task}.`,
        skipped: [],
      };
    }

    const skipped: SkippedRoute[] = [];
    const degraded: BackendId[] = [];

    for (const backend of candidates) {
      const record = this.health.get(backend);
      this.circuits.observe(record, now);

      if (record.status === "POLICY_DENIED") {
        return {
          decision: "BLOCKED_POLICY",
          reason: `${backend} reported POLICY_DENIED; fallback is intentionally prohibited.`,
          skipped: [
            ...skipped,
            { backend, status: record.status, reason: record.reason ?? "policy denied" },
          ],
        };
      }

      const circuitAllowed = this.circuits.canAttempt(backend, now);
      if (record.status === "HEALTHY" && circuitAllowed) {
        return {
          decision: "ROUTE",
          backend,
          degraded: false,
          reason: `Selected healthy backend ${backend}.`,
          skipped,
        };
      }
      if (record.status === "DEGRADED" && circuitAllowed) {
        degraded.push(backend);
        continue;
      }

      skipped.push({
        backend,
        status: record.status,
        reason: skipReason(record, circuitAllowed),
      });
    }

    for (const backend of degraded) {
      return {
        decision: "ROUTE",
        backend,
        degraded: true,
        reason: `No healthy backend was available; selected degraded backend ${backend}.`,
        skipped,
      };
    }

    return {
      decision: "UNAVAILABLE",
      reason: `No eligible backend is currently available for ${request.task}.`,
      skipped,
    };
  }
}
