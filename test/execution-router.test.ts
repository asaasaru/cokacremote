import { describe, expect, it } from "vitest";

import { BackendHealthRegistry } from "../src/backend-health.js";
import { BackendCircuitBreaker } from "../src/circuit-breaker.js";
import { ExecutionRouter } from "../src/execution-router.js";

function healthyRegistry(): BackendHealthRegistry {
  const registry = new BackendHealthRegistry(undefined, 0);
  for (const backend of registry.list().map((item) => item.backend)) {
    registry.markHealthy(backend, 100);
  }
  return registry;
}

describe("ExecutionRouter", () => {
  it("prefers Antigravity for project work when healthy", () => {
    const router = new ExecutionRouter(healthyRegistry(), new BackendCircuitBreaker());
    expect(router.route({
      task: "project.write",
      policyDecision: "ALLOW",
    }, 200)).toMatchObject({
      decision: "ROUTE",
      backend: "agentcore.antigravity",
    });
  });

  it("falls back to AgentCore native when Antigravity needs login", () => {
    const registry = healthyRegistry();
    registry.update("agentcore.antigravity", "AUTH_REQUIRED", {
      observedAt: 150,
      reason: "session expired",
      manualActionRequired: true,
    });
    const router = new ExecutionRouter(registry, new BackendCircuitBreaker());

    expect(router.route({
      task: "project.test",
      policyDecision: "ALLOW",
    }, 200)).toMatchObject({
      decision: "ROUTE",
      backend: "agentcore.native",
    });
  });

  it("falls back when Antigravity subscription is unavailable", () => {
    const registry = healthyRegistry();
    registry.update("agentcore.antigravity", "SUBSCRIPTION_REQUIRED", { observedAt: 150 });
    const router = new ExecutionRouter(registry, new BackendCircuitBreaker());

    expect(router.route({
      task: "project.exec",
      policyDecision: "ALLOW",
    }, 200)).toMatchObject({
      decision: "ROUTE",
      backend: "agentcore.native",
    });
  });

  it("prefers the TradingView bridge for compile/backtest", () => {
    const router = new ExecutionRouter(healthyRegistry(), new BackendCircuitBreaker());
    expect(router.route({
      task: "tradingview.compile",
      policyDecision: "ALLOW",
    }, 200)).toMatchObject({
      decision: "ROUTE",
      backend: "tv_bridge",
    });
  });

  it("falls back from a rate-limited TV bridge", () => {
    const registry = healthyRegistry();
    registry.update("tv_bridge", "RATE_LIMITED", {
      observedAt: 150,
      retryAfter: 5000,
    });
    const router = new ExecutionRouter(registry, new BackendCircuitBreaker());

    expect(router.route({
      task: "tradingview.backtest",
      policyDecision: "ALLOW",
    }, 200)).toMatchObject({
      decision: "ROUTE",
      backend: "agentcore.native",
    });
  });

  it("uses Remote Desktop for GUI-only work", () => {
    const router = new ExecutionRouter(healthyRegistry(), new BackendCircuitBreaker());
    expect(router.route({
      task: "tradingview.gui",
      policyDecision: "ALLOW",
    }, 200)).toMatchObject({
      decision: "ROUTE",
      backend: "remote_desktop",
    });
  });

  it("never chooses an executor before approval", () => {
    const router = new ExecutionRouter(healthyRegistry(), new BackendCircuitBreaker());
    expect(router.route({
      task: "project.write",
      policyDecision: "APPROVAL_REQUIRED",
    })).toMatchObject({
      decision: "APPROVAL_REQUIRED",
    });
  });

  it("never falls back around a capability policy denial", () => {
    const router = new ExecutionRouter(healthyRegistry(), new BackendCircuitBreaker());
    expect(router.route({
      task: "project.write",
      policyDecision: "DENY",
    })).toMatchObject({
      decision: "BLOCKED_POLICY",
    });
  });

  it("never falls back when a selected backend reports POLICY_DENIED", () => {
    const registry = healthyRegistry();
    registry.update("agentcore.antigravity", "POLICY_DENIED", {
      observedAt: 150,
      reason: "outside approved workspace",
    });
    const router = new ExecutionRouter(registry, new BackendCircuitBreaker());

    const decision = router.route({
      task: "project.write",
      policyDecision: "ALLOW",
    }, 200);
    expect(decision.decision).toBe("BLOCKED_POLICY");
    expect(decision.backend).toBeUndefined();
  });

  it("supports explicit CPAA/RDC/TV bridge route modes without widening scope", () => {
    const router = new ExecutionRouter(healthyRegistry(), new BackendCircuitBreaker());

    expect(router.route({
      task: "project.read",
      mode: "cpaa",
      policyDecision: "ALLOW",
    }, 200).backend).toBe("agentcore.antigravity");

    expect(router.route({
      task: "project.read",
      mode: "rdc",
      policyDecision: "ALLOW",
    }, 200).backend).toBe("remote_desktop");

    expect(router.route({
      task: "tradingview.compile",
      mode: "tvbridge",
      policyDecision: "ALLOW",
    }, 200).backend).toBe("tv_bridge");

    expect(router.route({
      task: "project.write",
      mode: "tvbridge",
      policyDecision: "ALLOW",
    }, 200).decision).toBe("UNAVAILABLE");
  });

  it("treats unknown health as a bounded live probe instead of offline failure", () => {
    const registry = new BackendHealthRegistry(undefined, 0);
    const router = new ExecutionRouter(registry, new BackendCircuitBreaker());

    expect(router.route({
      task: "project.read",
      mode: "rdc",
      policyDecision: "ALLOW",
    }, 200)).toMatchObject({
      decision: "PROBE",
      backend: "remote_desktop",
      degraded: true,
    });
  });

  it("prefers healthy fallback over a degraded first choice", () => {
    const registry = healthyRegistry();
    registry.update("agentcore.antigravity", "DEGRADED", {
      observedAt: 150,
      reason: "slow provider",
    });
    const router = new ExecutionRouter(registry, new BackendCircuitBreaker());

    expect(router.route({
      task: "project.test",
      policyDecision: "ALLOW",
    }, 200)).toMatchObject({
      decision: "ROUTE",
      backend: "agentcore.native",
      degraded: false,
    });
  });
});
