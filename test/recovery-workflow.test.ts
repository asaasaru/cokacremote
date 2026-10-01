import { describe, expect, it } from "vitest";

import type { BackendHealthRecord } from "../src/backend-health.js";
import { RecoveryWorkflow } from "../src/recovery-workflow.js";

function record(
  backend: BackendHealthRecord["backend"],
  status: BackendHealthRecord["status"],
): BackendHealthRecord {
  return {
    backend,
    status,
    observedAt: 100,
    consecutiveFailures: 1,
  };
}

describe("RecoveryWorkflow", () => {
  const workflow = new RecoveryWorkflow();

  it("treats Antigravity login as human auth plus safe fallback", () => {
    const plan = workflow.plan(record("agentcore.antigravity", "AUTH_REQUIRED"));
    expect(plan.automaticFallbackAllowed).toBe(true);
    expect(plan.retryAutomatically).toBe(false);
    expect(plan.steps.map((step) => step.id)).toEqual([
      "fallback",
      "operator-login",
      "canary",
    ]);
    expect(plan.steps[1]?.preferredExecutor).toBe("remote_desktop");
  });

  it("does not auto-retry subscription failures", () => {
    const plan = workflow.plan(record("agentcore.antigravity", "SUBSCRIPTION_REQUIRED"));
    expect(plan.automaticFallbackAllowed).toBe(true);
    expect(plan.retryAutomatically).toBe(false);
  });

  it("prohibits fallback on policy denial", () => {
    const plan = workflow.plan(record("agentcore.antigravity", "POLICY_DENIED"));
    expect(plan.automaticFallbackAllowed).toBe(false);
    expect(plan.retryAutomatically).toBe(false);
    expect(plan.steps[0]?.id).toBe("stop");
  });

  it("uses RDC only as AgentCore repair/bootstrap fallback", () => {
    const plan = workflow.plan(record("agentcore.native", "UNAVAILABLE"));
    expect(plan.steps.some((step) =>
      step.id === "repair-agentcore" && step.preferredExecutor === "remote_desktop"
    )).toBe(true);
    expect(plan.steps.some((step) =>
      step.id === "canary" && step.preferredExecutor === "agentcore.native"
    )).toBe(true);
  });
});
