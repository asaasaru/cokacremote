import { describe, expect, it } from "vitest";

import { classifyBackendObservation } from "../src/backend-outcome-classifier.js";

describe("classifyBackendObservation", () => {
  it("maps successful verified probes to HEALTHY", () => {
    expect(classifyBackendObservation({
      backend: "agentcore.native",
      ok: true,
      message: "canary passed",
      observedAt: 100,
    })).toMatchObject({
      status: "HEALTHY",
      manualActionRequired: false,
      observedAt: 100,
    });
  });

  it("classifies login/session failures as AUTH_REQUIRED", () => {
    expect(classifyBackendObservation({
      backend: "agentcore.antigravity",
      ok: false,
      errorCode: "SESSION_EXPIRED",
    }).status).toBe("AUTH_REQUIRED");

    expect(classifyBackendObservation({
      backend: "agentcore.antigravity",
      ok: false,
      httpStatus: 401,
    }).status).toBe("AUTH_REQUIRED");
  });

  it("classifies subscription/account payment states separately from auth", () => {
    expect(classifyBackendObservation({
      backend: "agentcore.antigravity",
      ok: false,
      errorCode: "SUBSCRIPTION_INACTIVE",
    }).status).toBe("SUBSCRIPTION_REQUIRED");

    expect(classifyBackendObservation({
      backend: "agentcore.antigravity",
      ok: false,
      httpStatus: 402,
    }).status).toBe("SUBSCRIPTION_REQUIRED");
  });

  it("preserves retryAfter for rate limits", () => {
    expect(classifyBackendObservation({
      backend: "tv_bridge",
      ok: false,
      httpStatus: 429,
      retryAfter: 5000,
    })).toMatchObject({
      status: "RATE_LIMITED",
      retryAfter: 5000,
      manualActionRequired: false,
    });
  });

  it("requires an explicit structured policy code for POLICY_DENIED", () => {
    expect(classifyBackendObservation({
      backend: "agentcore.antigravity",
      ok: false,
      errorCode: "OUTSIDE_APPROVED_WORKSPACE",
    }).status).toBe("POLICY_DENIED");

    // Do not accidentally convert a generic provider 403 into a no-fallback
    // policy decision without trustworthy structured evidence.
    expect(classifyBackendObservation({
      backend: "agentcore.antigravity",
      ok: false,
      httpStatus: 403,
      message: "Forbidden",
    }).status).toBe("DEGRADED");
  });

  it("classifies transport/service failures as UNAVAILABLE", () => {
    expect(classifyBackendObservation({
      backend: "remote_desktop",
      ok: false,
      errorCode: "DEVICE_UNAVAILABLE",
    }).status).toBe("UNAVAILABLE");

    expect(classifyBackendObservation({
      backend: "tv_bridge",
      ok: false,
      httpStatus: 503,
    }).status).toBe("UNAVAILABLE");
  });

  it("uses DEGRADED for unknown failures instead of inventing an auth or policy cause", () => {
    expect(classifyBackendObservation({
      backend: "agentcore.antigravity",
      ok: false,
      message: "unexpected provider response",
    }).status).toBe("DEGRADED");
  });
});
