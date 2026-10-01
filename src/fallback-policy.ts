import type { BackendId } from "./backend-health.js";
import type { ExecutionTaskKind } from "./execution-adapters.js";

export type ExecutionMode = "auto" | "cpaa" | "rdc" | "tvbridge" | "local";

export interface FallbackProfile {
  id: string;
  routes: Record<ExecutionTaskKind, BackendId[]>;
}

export const DEFAULT_FALLBACK_PROFILE: FallbackProfile = {
  id: "default",
  routes: {
    "project.read": ["agentcore.antigravity", "agentcore.native", "remote_desktop"],
    "project.write": ["agentcore.antigravity", "agentcore.native", "remote_desktop"],
    "project.test": ["agentcore.antigravity", "agentcore.native", "remote_desktop"],
    "project.exec": ["agentcore.antigravity", "agentcore.native", "remote_desktop"],
    "agentcore.canary": ["agentcore.native", "remote_desktop"],
    "agentcore.repair": ["remote_desktop"],
    "tradingview.compile": ["tv_bridge", "agentcore.native", "remote_desktop"],
    "tradingview.backtest": ["tv_bridge", "agentcore.native", "remote_desktop"],
    "tradingview.gui": ["remote_desktop"],
    "coka.sandbox": ["coka_local"],
  },
};

function modeMatches(backend: BackendId, mode: ExecutionMode): boolean {
  if (mode === "auto") {
    return true;
  }
  if (mode === "cpaa") {
    return backend.startsWith("agentcore.");
  }
  if (mode === "rdc") {
    return backend === "remote_desktop";
  }
  if (mode === "tvbridge") {
    return backend === "tv_bridge";
  }
  return backend === "coka_local";
}

export class FallbackPolicy {
  constructor(private readonly profile: FallbackProfile = DEFAULT_FALLBACK_PROFILE) {}

  candidates(task: ExecutionTaskKind, mode: ExecutionMode = "auto"): BackendId[] {
    return this.profile.routes[task].filter((backend) => modeMatches(backend, mode));
  }

  withoutBackend(backend: BackendId): FallbackPolicy {
    const routes = Object.fromEntries(
      Object.entries(this.profile.routes).map(([task, candidates]) => [
        task,
        candidates.filter((candidate) => candidate !== backend),
      ]),
    ) as Record<ExecutionTaskKind, BackendId[]>;
    return new FallbackPolicy({
      id: `${this.profile.id}:without:${backend}`,
      routes,
    });
  }

  profileId(): string {
    return this.profile.id;
  }
}
