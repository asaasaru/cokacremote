export type BackendId =
  | "agentcore.antigravity"
  | "agentcore.native"
  | "remote_desktop"
  | "tv_bridge"
  | "coka_local";

export type BackendHealthStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "AUTH_REQUIRED"
  | "SUBSCRIPTION_REQUIRED"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "POLICY_DENIED"
  | "REPAIRING"
  | "UNKNOWN";

export interface BackendHealthRecord {
  backend: BackendId;
  status: BackendHealthStatus;
  reason?: string;
  observedAt: number;
  lastSuccessAt?: number;
  retryAfter?: number;
  manualActionRequired?: boolean;
  consecutiveFailures: number;
}

const DEFAULT_BACKENDS: BackendId[] = [
  "agentcore.antigravity",
  "agentcore.native",
  "remote_desktop",
  "tv_bridge",
  "coka_local",
];

function cloneRecord(record: BackendHealthRecord): BackendHealthRecord {
  return { ...record };
}

export class BackendHealthRegistry {
  private readonly records = new Map<BackendId, BackendHealthRecord>();

  constructor(backends: BackendId[] = DEFAULT_BACKENDS, now = Date.now()) {
    for (const backend of backends) {
      this.records.set(backend, {
        backend,
        status: "UNKNOWN",
        observedAt: now,
        consecutiveFailures: 0,
      });
    }
  }

  get(backend: BackendId): BackendHealthRecord {
    const record = this.records.get(backend);
    if (!record) {
      throw new Error(`Unknown backend: ${backend}`);
    }
    return cloneRecord(record);
  }

  list(): BackendHealthRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }

  update(
    backend: BackendId,
    status: BackendHealthStatus,
    options: {
      reason?: string;
      observedAt?: number;
      retryAfter?: number;
      manualActionRequired?: boolean;
    } = {},
  ): BackendHealthRecord {
    const current = this.get(backend);
    const observedAt = options.observedAt ?? Date.now();
    const success = status === "HEALTHY";
    const failure =
      status === "AUTH_REQUIRED" ||
      status === "SUBSCRIPTION_REQUIRED" ||
      status === "RATE_LIMITED" ||
      status === "UNAVAILABLE" ||
      status === "POLICY_DENIED";

    const next: BackendHealthRecord = {
      ...current,
      status,
      reason: options.reason,
      observedAt,
      retryAfter: options.retryAfter,
      manualActionRequired: options.manualActionRequired,
      lastSuccessAt: success ? observedAt : current.lastSuccessAt,
      consecutiveFailures: success ? 0 : failure ? current.consecutiveFailures + 1 : current.consecutiveFailures,
    };
    this.records.set(backend, next);
    return cloneRecord(next);
  }

  markHealthy(backend: BackendId, now = Date.now()): BackendHealthRecord {
    return this.update(backend, "HEALTHY", { observedAt: now, manualActionRequired: false });
  }
}
