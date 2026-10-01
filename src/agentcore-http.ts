import express from "express";

import { type AgentCoreBackend, type AgentCoreSafeResult, AgentCoreBroker } from "./agentcore-broker.js";
import { tokensEqual } from "./auth.js";
import type { BackendHealthRegistry } from "./backend-health.js";
import type { BackendCircuitBreaker } from "./circuit-breaker.js";
import type { AppConfig } from "./config.js";

const BACKENDS = new Set<AgentCoreBackend>(["agentcore.native", "agentcore.antigravity"]);
const PLATFORMS = new Set(["macos", "windows"]);
const TERMINAL = new Set(["completed", "failed", "blocked", "cancelled"]);

function authenticateDevice(
  request: express.Request,
  config: AppConfig,
): string | undefined {
  const deviceId = request.header("x-coka-agentcore-device")?.trim();
  const supplied = request.header("x-coka-agentcore-key") ?? "";
  if (!deviceId) {
    return undefined;
  }
  const expected = config.agentcoreDeviceKeys[deviceId];
  if (!expected || !supplied || !tokensEqual(supplied, expected)) {
    return undefined;
  }
  return deviceId;
}

function stringArray(
  value: unknown,
  name: string,
  maxItems = 100,
  maxLength = 2048,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== "string" || item.length > maxLength)
  ) {
    throw new Error(`invalid_${name}`);
  }
  return value as string[];
}

function safeResult(value: unknown): AgentCoreSafeResult {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_result");
  }
  const body = value as Record<string, unknown>;
  const result: AgentCoreSafeResult = {};
  for (const field of ["summary", "errorCode", "errorMessage"] as const) {
    const item = body[field];
    if (item !== undefined) {
      if (typeof item !== "string" || item.length > 10_000) {
        throw new Error(`invalid_${field}`);
      }
      result[field] = item;
    }
  }
  if (body.output !== undefined) {
    if (typeof body.output !== "string" || body.output.length > 65_536) {
      throw new Error("invalid_output");
    }
    result.output = body.output;
  }
  result.facts = stringArray(body.facts, "facts", 100, 4096);
  result.changedPaths = stringArray(body.changedPaths, "changedPaths");
  result.deniedActions = stringArray(body.deniedActions, "deniedActions");
  result.evidencePaths = stringArray(body.evidencePaths, "evidencePaths");
  if (body.testsPassed !== undefined) {
    if (typeof body.testsPassed !== "boolean") {
      throw new Error("invalid_testsPassed");
    }
    result.testsPassed = body.testsPassed;
  }
  return result;
}

export function registerAgentCoreRoutes(
  app: express.Express,
  config: AppConfig,
  broker: AgentCoreBroker,
  health: BackendHealthRegistry,
  circuits: BackendCircuitBreaker,
): void {
  const json = express.json({ limit: "128kb" });

  const authorized = (
    request: express.Request,
    response: express.Response,
  ): string | undefined => {
    if (!broker.enabled()) {
      response.status(404).json({ error: "not_found" });
      return undefined;
    }
    const deviceId = authenticateDevice(request, config);
    if (!deviceId) {
      response.status(401).json({ error: "unauthorized" });
      return undefined;
    }
    return deviceId;
  };

  app.post("/internal/agentcore/register", json, (request, response) => {
    const deviceId = authorized(request, response);
    if (!deviceId) return;
    try {
      const body = request.body as Record<string, unknown>;
      const platform = body.platform;
      const version = body.version;
      const fingerprint = body.fingerprint;
      const projectsRaw = body.projects;
      const backendsRaw = body.backends;
      if (
        typeof platform !== "string" ||
        !PLATFORMS.has(platform) ||
        typeof version !== "string" ||
        version.length < 1 ||
        version.length > 128 ||
        typeof fingerprint !== "string" ||
        fingerprint.length < 1 ||
        fingerprint.length > 256 ||
        !Array.isArray(projectsRaw) ||
        projectsRaw.length < 1 ||
        projectsRaw.length > 100 ||
        !Array.isArray(backendsRaw) ||
        backendsRaw.length < 1 ||
        backendsRaw.length > 2
      ) {
        response.status(400).json({ error: "invalid_registration" });
        return;
      }
      const projects = projectsRaw.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error("invalid_projects");
        }
        const projectId = (item as Record<string, unknown>).projectId;
        const root = (item as Record<string, unknown>).root;
        if (
          typeof projectId !== "string" ||
          projectId.length < 1 ||
          projectId.length > 128 ||
          typeof root !== "string" ||
          root.length < 1 ||
          root.length > 2048
        ) {
          throw new Error("invalid_projects");
        }
        return { projectId, root };
      });
      const backends = backendsRaw.map((backend) => {
        if (typeof backend !== "string" || !BACKENDS.has(backend as AgentCoreBackend)) {
          throw new Error("invalid_backends");
        }
        return backend as AgentCoreBackend;
      });
      const device = broker.register({
        deviceId,
        platform: platform as "macos" | "windows",
        version,
        fingerprint,
        projects,
        backends,
      });
      for (const backend of device.backends) {
        const record = health.markHealthy(backend, device.lastSeenAt);
        circuits.observe(record, device.lastSeenAt);
      }
      response.json({
        device: {
          deviceId: device.deviceId,
          platform: device.platform,
          version: device.version,
          fingerprint: device.fingerprint,
          projects: device.projects,
          backends: device.backends,
          lastSeenAt: device.lastSeenAt,
        },
      });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "invalid_registration",
      });
    }
  });

  app.post("/internal/agentcore/heartbeat", json, (request, response) => {
    const deviceId = authorized(request, response);
    if (!deviceId) return;
    try {
      const device = broker.heartbeat(deviceId);
      for (const backend of device.backends) {
        const record = health.markHealthy(backend, device.lastSeenAt);
        circuits.observe(record, device.lastSeenAt);
      }
      response.json({ ok: true, lastSeenAt: device.lastSeenAt });
    } catch (error) {
      response.status(409).json({
        error: error instanceof Error ? error.message : "heartbeat_failed",
      });
    }
  });

  app.post("/internal/agentcore/poll", json, (request, response) => {
    const deviceId = authorized(request, response);
    if (!deviceId) return;
    try {
      const job = broker.poll(deviceId);
      response.json({ job: job ?? null });
    } catch (error) {
      response.status(409).json({
        error: error instanceof Error ? error.message : "poll_failed",
      });
    }
  });

  app.post("/internal/agentcore/result", json, (request, response) => {
    const deviceId = authorized(request, response);
    if (!deviceId) return;
    try {
      const body = request.body as Record<string, unknown>;
      const requestId = body.requestId;
      const status = body.status;
      if (
        typeof requestId !== "string" ||
        !/^[0-9a-fA-F-]{36}$/.test(requestId) ||
        typeof status !== "string" ||
        !TERMINAL.has(status)
      ) {
        response.status(400).json({ error: "invalid_result_envelope" });
        return;
      }
      const result = safeResult(body.result);
      const job = broker.complete(
        deviceId,
        requestId,
        status as "completed" | "failed" | "blocked" | "cancelled",
        result,
      );
      const backendStatus =
        status === "completed" ? "HEALTHY" : status === "blocked" ? "POLICY_DENIED" : "DEGRADED";
      const record = health.update(job.backend, backendStatus, {
        reason:
          result.errorMessage ??
          (status === "completed" ? "AgentCore request completed" : `AgentCore request ${status}`),
      });
      circuits.observe(record);
      response.json({ ok: true, requestId: job.requestId, status: job.status });
    } catch (error) {
      response.status(409).json({
        error: error instanceof Error ? error.message : "result_failed",
      });
    }
  });
}
