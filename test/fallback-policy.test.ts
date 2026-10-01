import { describe, expect, it } from "vitest";

import { FallbackPolicy } from "../src/fallback-policy.js";

describe("FallbackPolicy", () => {
  it("uses Antigravity as an optional first provider for project work", () => {
    const policy = new FallbackPolicy();
    expect(policy.candidates("project.write")).toEqual([
      "agentcore.antigravity",
      "agentcore.native",
      "remote_desktop",
    ]);
  });

  it("supports explicit execution modes without adding new candidates", () => {
    const policy = new FallbackPolicy();
    expect(policy.candidates("project.write", "cpaa")).toEqual([
      "agentcore.antigravity",
      "agentcore.native",
    ]);
    expect(policy.candidates("project.write", "rdc")).toEqual(["remote_desktop"]);
    expect(policy.candidates("tradingview.compile", "tvbridge")).toEqual(["tv_bridge"]);
    expect(policy.candidates("project.write", "tvbridge")).toEqual([]);
  });

  it("can disable Antigravity without changing the rest of the route", () => {
    const policy = new FallbackPolicy().withoutBackend("agentcore.antigravity");
    expect(policy.candidates("project.test")).toEqual([
      "agentcore.native",
      "remote_desktop",
    ]);
  });
});
