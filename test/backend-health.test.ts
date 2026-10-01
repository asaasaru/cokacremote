import { describe, expect, it } from "vitest";

import { BackendHealthRegistry } from "../src/backend-health.js";
import { BackendCircuitBreaker } from "../src/circuit-breaker.js";

describe("BackendHealthRegistry", () => {
  it("starts backends as UNKNOWN and resets failures on health", () => {
    const registry = new BackendHealthRegistry(["agentcore.antigravity"], 100);
    expect(registry.get("agentcore.antigravity").status).toBe("UNKNOWN");

    registry.update("agentcore.antigravity", "UNAVAILABLE", { observedAt: 200 });
    expect(registry.get("agentcore.antigravity").consecutiveFailures).toBe(1);

    registry.markHealthy("agentcore.antigravity", 300);
    expect(registry.get("agentcore.antigravity")).toMatchObject({
      status: "HEALTHY",
      consecutiveFailures: 0,
      lastSuccessAt: 300,
    });
  });
});

describe("BackendCircuitBreaker", () => {
  it("opens after repeated transient failures and half-opens after cooldown", () => {
    const registry = new BackendHealthRegistry(["agentcore.native"], 0);
    const breaker = new BackendCircuitBreaker(2, 1000);

    breaker.observe(registry.update("agentcore.native", "UNAVAILABLE", { observedAt: 100 }), 100);
    expect(breaker.snapshot("agentcore.native").state).toBe("CLOSED");

    breaker.observe(registry.update("agentcore.native", "UNAVAILABLE", { observedAt: 200 }), 200);
    expect(breaker.snapshot("agentcore.native")).toMatchObject({
      state: "OPEN",
      retryAt: 1200,
    });
    expect(breaker.canAttempt("agentcore.native", 1199)).toBe(false);
    expect(breaker.canAttempt("agentcore.native", 1200)).toBe(true);
    expect(breaker.snapshot("agentcore.native").state).toBe("HALF_OPEN");
    expect(breaker.canAttempt("agentcore.native", 1201)).toBe(false);
  });

  it("opens immediately for auth and subscription failures", () => {
    const registry = new BackendHealthRegistry(["agentcore.antigravity"], 0);
    const breaker = new BackendCircuitBreaker();

    breaker.observe(registry.update("agentcore.antigravity", "AUTH_REQUIRED", { observedAt: 100 }), 100);
    expect(breaker.snapshot("agentcore.antigravity")).toMatchObject({
      state: "OPEN",
      reason: "AUTH_REQUIRED",
      retryAt: undefined,
    });

    breaker.observe(registry.markHealthy("agentcore.antigravity", 200), 200);
    expect(breaker.snapshot("agentcore.antigravity").state).toBe("CLOSED");

    breaker.observe(registry.update("agentcore.antigravity", "SUBSCRIPTION_REQUIRED", { observedAt: 300 }), 300);
    expect(breaker.canAttempt("agentcore.antigravity", 100000)).toBe(false);
  });

  it("uses retryAfter for rate limits", () => {
    const registry = new BackendHealthRegistry(["tv_bridge"], 0);
    const breaker = new BackendCircuitBreaker();

    breaker.observe(registry.update("tv_bridge", "RATE_LIMITED", {
      observedAt: 100,
      retryAfter: 5000,
    }), 100);

    expect(breaker.canAttempt("tv_bridge", 4999)).toBe(false);
    expect(breaker.canAttempt("tv_bridge", 5000)).toBe(true);
  });
});
