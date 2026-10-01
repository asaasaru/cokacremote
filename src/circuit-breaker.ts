import type {
  BackendHealthRecord,
  BackendHealthStatus,
  BackendId,
} from "./backend-health.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitSnapshot {
  backend: BackendId;
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  retryAt?: number;
  reason?: BackendHealthStatus | "FAILURE_THRESHOLD";
}

interface MutableCircuit extends CircuitSnapshot {
  halfOpenClaimed: boolean;
}

const IMMEDIATE_OPEN = new Set<BackendHealthStatus>([
  "AUTH_REQUIRED",
  "SUBSCRIPTION_REQUIRED",
  "POLICY_DENIED",
  "REPAIRING",
]);

export class BackendCircuitBreaker {
  private readonly circuits = new Map<BackendId, MutableCircuit>();

  constructor(
    private readonly failureThreshold = 2,
    private readonly cooldownMs = 30_000,
  ) {}

  private ensure(backend: BackendId): MutableCircuit {
    const existing = this.circuits.get(backend);
    if (existing) {
      return existing;
    }
    const created: MutableCircuit = {
      backend,
      state: "CLOSED",
      consecutiveFailures: 0,
      halfOpenClaimed: false,
    };
    this.circuits.set(backend, created);
    return created;
  }

  observe(record: BackendHealthRecord, now = record.observedAt): CircuitSnapshot {
    const circuit = this.ensure(record.backend);

    if (record.status === "HEALTHY") {
      circuit.state = "CLOSED";
      circuit.consecutiveFailures = 0;
      circuit.openedAt = undefined;
      circuit.retryAt = undefined;
      circuit.reason = undefined;
      circuit.halfOpenClaimed = false;
      return this.snapshot(record.backend);
    }

    if (record.status === "DEGRADED" || record.status === "UNKNOWN") {
      return this.snapshot(record.backend);
    }

    if (record.status === "RATE_LIMITED") {
      circuit.state = "OPEN";
      circuit.openedAt = now;
      circuit.retryAt = record.retryAfter ?? now + this.cooldownMs;
      circuit.reason = "RATE_LIMITED";
      circuit.halfOpenClaimed = false;
      return this.snapshot(record.backend);
    }

    if (IMMEDIATE_OPEN.has(record.status)) {
      circuit.state = "OPEN";
      circuit.openedAt = now;
      circuit.retryAt = undefined;
      circuit.reason = record.status;
      circuit.halfOpenClaimed = false;
      return this.snapshot(record.backend);
    }

    if (record.status === "UNAVAILABLE") {
      circuit.consecutiveFailures += 1;
      if (circuit.consecutiveFailures >= this.failureThreshold) {
        circuit.state = "OPEN";
        circuit.openedAt = now;
        circuit.retryAt = now + this.cooldownMs;
        circuit.reason = "FAILURE_THRESHOLD";
        circuit.halfOpenClaimed = false;
      }
    }

    return this.snapshot(record.backend);
  }

  canAttempt(backend: BackendId, now = Date.now()): boolean {
    const circuit = this.ensure(backend);
    if (circuit.state === "CLOSED") {
      return true;
    }
    if (circuit.state === "HALF_OPEN") {
      if (circuit.halfOpenClaimed) {
        return false;
      }
      circuit.halfOpenClaimed = true;
      return true;
    }
    if (circuit.retryAt !== undefined && circuit.retryAt <= now) {
      circuit.state = "HALF_OPEN";
      circuit.halfOpenClaimed = true;
      return true;
    }
    return false;
  }

  snapshot(backend: BackendId): CircuitSnapshot {
    const circuit = this.ensure(backend);
    return {
      backend,
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      openedAt: circuit.openedAt,
      retryAt: circuit.retryAt,
      reason: circuit.reason,
    };
  }
}
