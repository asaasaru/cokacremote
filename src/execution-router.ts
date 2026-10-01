import type { PolicyDecisionKind } from "./capability-policy.js";
import {
  type BackendHealthRecord,
  type BackendHealthStatus,
  type BackendId,
  BackendHealthRegistry,
} from "./backend-health.js";
import { BackendCircuitBreaker } from "./circuit-breaker.js";
import type { ExecutionTaskKind } from "./execution-adapters.js";
import {
  type ExecutionMode,
  FallbackPolicy,
} from "./fallback-policy.js";

export interface ExecutionRouteRequest {
  task: ExecutionTaskKind;
  mode?: ExecutionMode;
  policyDecision: PolicyDecisionKind;
}

export type RouteDecisionKind =
  | "ROUTE"
  | "PROBE"
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
    private readonly fallback: FallbackPolicy = new FallbackPolicy(),
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

    const candidates = this.fallback.candidates(request.task, request.mode ?? "auto");
    if (candidates.length === 0) {
      return {
        decision: "UNAVAILABLE",
        reason: `Execution mode ${request.mode ?? "auto"} has no valid backend for ${request.task}.`,
        skipped: [],
      };
    }

    const skipped: SkippedRoute[] = [];
    const degraded: BackendId[] = [];
    const unknown: BackendId[] = [];

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
          reason: `Selected healthy backend ${backend} using fallback profile ${this.fallback.profileId()}.`,
          skipped,
        };
      }
      if (record.status === "DEGRADED" && circuitAllowed) {
        degraded.push(backend);
        continue;
      }
      if (record.status === "UNKNOWN" && circuitAllowed) {
        unknown.push(backend);
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

    for (const backend of unknown) {
      return {
        decision: "PROBE",
        backend,
        degraded: true,
        reason: `Backend ${backend} has no fresh verified health observation; allow one bounded live probe instead of treating stale/unknown telemetry as failure.`,
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
