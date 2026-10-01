import type { BackendHealthStatus, BackendId } from "./backend-health.js";

export interface BackendObservation {
  backend: BackendId;
  ok: boolean;
  errorCode?: string;
  httpStatus?: number;
  message?: string;
  retryAfter?: number;
  observedAt?: number;
}

export interface ClassifiedBackendObservation {
  backend: BackendId;
  status: BackendHealthStatus;
  reason?: string;
  retryAfter?: number;
  manualActionRequired: boolean;
  observedAt: number;
}

const AUTH_CODES = new Set([
  "AUTH_REQUIRED",
  "UNAUTHENTICATED",
  "LOGIN_REQUIRED",
  "SESSION_EXPIRED",
  "TOKEN_EXPIRED",
]);

const SUBSCRIPTION_CODES = new Set([
  "SUBSCRIPTION_REQUIRED",
  "SUBSCRIPTION_INACTIVE",
  "PLAN_REQUIRED",
  "PAYMENT_REQUIRED",
]);

const RATE_LIMIT_CODES = new Set([
  "RATE_LIMITED",
  "TOO_MANY_REQUESTS",
  "QUOTA_EXCEEDED",
]);

const POLICY_CODES = new Set([
  "POLICY_DENIED",
  "SCOPE_DENIED",
  "OUTSIDE_APPROVED_WORKSPACE",
  "MANIFEST_DENIED",
]);

const UNAVAILABLE_CODES = new Set([
  "UNAVAILABLE",
  "CONNECTION_FAILED",
  "CONNECTION_REFUSED",
  "TIMEOUT",
  "SERVICE_UNAVAILABLE",
  "DEVICE_UNAVAILABLE",
]);

function normalizedCode(code: string | undefined): string | undefined {
  return code?.trim().toUpperCase().replaceAll("-", "_").replaceAll(" ", "_");
}

export function classifyBackendObservation(
  observation: BackendObservation,
  now = Date.now(),
): ClassifiedBackendObservation {
  const observedAt = observation.observedAt ?? now;
  const code = normalizedCode(observation.errorCode);
  const reason = observation.message || code;

  if (observation.ok) {
    return {
      backend: observation.backend,
      status: "HEALTHY",
      reason: observation.message,
      manualActionRequired: false,
      observedAt,
    };
  }

  // Explicit structured policy codes take precedence over generic HTTP status.
  // A bare 403 is intentionally NOT considered POLICY_DENIED because it can
  // represent provider auth, account state, WAF, or other unrelated failures.
  if (code && POLICY_CODES.has(code)) {
    return {
      backend: observation.backend,
      status: "POLICY_DENIED",
      reason,
      manualActionRequired: true,
      observedAt,
    };
  }

  if ((code && AUTH_CODES.has(code)) || observation.httpStatus === 401) {
    return {
      backend: observation.backend,
      status: "AUTH_REQUIRED",
      reason,
      manualActionRequired: true,
      observedAt,
    };
  }

  if (
    (code && SUBSCRIPTION_CODES.has(code)) ||
    observation.httpStatus === 402
  ) {
    return {
      backend: observation.backend,
      status: "SUBSCRIPTION_REQUIRED",
      reason,
      manualActionRequired: true,
      observedAt,
    };
  }

  if (
    (code && RATE_LIMIT_CODES.has(code)) ||
    observation.httpStatus === 429
  ) {
    return {
      backend: observation.backend,
      status: "RATE_LIMITED",
      reason,
      retryAfter: observation.retryAfter,
      manualActionRequired: false,
      observedAt,
    };
  }

  if (
    (code && UNAVAILABLE_CODES.has(code)) ||
    observation.httpStatus === 502 ||
    observation.httpStatus === 503 ||
    observation.httpStatus === 504
  ) {
    return {
      backend: observation.backend,
      status: "UNAVAILABLE",
      reason,
      manualActionRequired: false,
      observedAt,
    };
  }

  return {
    backend: observation.backend,
    status: "DEGRADED",
    reason: reason ?? "Unclassified backend failure",
    manualActionRequired: false,
    observedAt,
  };
}
