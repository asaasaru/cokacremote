import express from "express";

import {
  type BackendId,
  BackendHealthRegistry,
} from "./backend-health.js";
import { classifyBackendObservation } from "./backend-outcome-classifier.js";
import { tokensEqual } from "./auth.js";
import { BackendCircuitBreaker } from "./circuit-breaker.js";
import type { AppConfig } from "./config.js";

const EXTERNAL_BACKENDS = new Set<BackendId>([
  "agentcore.antigravity",
  "agentcore.native",
  "remote_desktop",
  "tv_bridge",
]);

function integerOrUndefined(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}

export function registerBackendHealthRoutes(
  app: express.Express,
  config: AppConfig,
  health: BackendHealthRegistry,
  circuits: BackendCircuitBreaker,
): void {
  const json = express.json({ limit: "16kb" });

  app.post("/internal/backend-health", json, (request, response) => {
    if (!config.backendHealthKey) {
      response.status(404).json({ error: "not_found" });
      return;
    }

    const supplied = request.header("x-coka-health-key") ?? "";
    if (!supplied || !tokensEqual(supplied, config.backendHealthKey)) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }

    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      response.status(400).json({ error: "invalid_body" });
      return;
    }

    const backend = (body as { backend?: unknown }).backend;
    const ok = (body as { ok?: unknown }).ok;
    if (typeof backend !== "string" || !EXTERNAL_BACKENDS.has(backend as BackendId)) {
      response.status(400).json({ error: "invalid_backend" });
      return;
    }
    if (typeof ok !== "boolean") {
      response.status(400).json({ error: "invalid_ok" });
      return;
    }

    const errorCode = (body as { errorCode?: unknown }).errorCode;
    const message = (body as { message?: unknown }).message;
    const httpStatusRaw = (body as { httpStatus?: unknown }).httpStatus;
    const retryAfterRaw = (body as { retryAfter?: unknown }).retryAfter;
    const observedAtRaw = (body as { observedAt?: unknown }).observedAt;

    if (errorCode !== undefined && typeof errorCode !== "string") {
      response.status(400).json({ error: "invalid_error_code" });
      return;
    }
    if (message !== undefined && typeof message !== "string") {
      response.status(400).json({ error: "invalid_message" });
      return;
    }
    if (httpStatusRaw !== undefined && !Number.isSafeInteger(httpStatusRaw)) {
      response.status(400).json({ error: "invalid_http_status" });
      return;
    }
    if (retryAfterRaw !== undefined && !Number.isSafeInteger(retryAfterRaw)) {
      response.status(400).json({ error: "invalid_retry_after" });
      return;
    }
    if (observedAtRaw !== undefined && !Number.isSafeInteger(observedAtRaw)) {
      response.status(400).json({ error: "invalid_observed_at" });
      return;
    }

    const classified = classifyBackendObservation({
      backend: backend as BackendId,
      ok,
      errorCode,
      message,
      httpStatus: integerOrUndefined(httpStatusRaw),
      retryAfter: integerOrUndefined(retryAfterRaw),
      observedAt: integerOrUndefined(observedAtRaw),
    });

    const record = health.update(classified.backend, classified.status, {
      reason: classified.reason,
      observedAt: classified.observedAt,
      retryAfter: classified.retryAfter,
      manualActionRequired: classified.manualActionRequired,
    });
    const circuit = circuits.observe(record, classified.observedAt);

    console.log(JSON.stringify({
      event: "backend_health_report",
      backend: record.backend,
      status: record.status,
      observedAt: record.observedAt,
      circuitState: circuit.state,
    }));

    response.json({ health: record, circuit });
  });
}
