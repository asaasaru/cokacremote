import type { BackendId } from "./backend-health.js";

export type ExecutionTaskKind =
  | "project.read"
  | "project.write"
  | "project.test"
  | "project.exec"
  | "agentcore.canary"
  | "agentcore.repair"
  | "tradingview.compile"
  | "tradingview.backtest"
  | "tradingview.gui"
  | "coka.sandbox";

export interface ExecutionAdapterDescriptor {
  id: BackendId;
  transport: "agentcore" | "remote_desktop" | "tv_bridge" | "coka";
  provider?: "native" | "antigravity";
  tasks: ExecutionTaskKind[];
  description: string;
}

export const EXECUTION_ADAPTERS: Record<BackendId, ExecutionAdapterDescriptor> = {
  "agentcore.antigravity": {
    id: "agentcore.antigravity",
    transport: "agentcore",
    provider: "antigravity",
    tasks: ["project.read", "project.write", "project.test", "project.exec"],
    description: "AgentCore/CPAA using Antigravity as an optional execution provider.",
  },
  "agentcore.native": {
    id: "agentcore.native",
    transport: "agentcore",
    provider: "native",
    tasks: [
      "project.read",
      "project.write",
      "project.test",
      "project.exec",
      "agentcore.canary",
      "tradingview.compile",
      "tradingview.backtest",
    ],
    description: "AgentCore/CPAA native bounded execution without Antigravity dependency.",
  },
  remote_desktop: {
    id: "remote_desktop",
    transport: "remote_desktop",
    tasks: [
      "project.read",
      "project.write",
      "project.test",
      "project.exec",
      "agentcore.repair",
      "tradingview.compile",
      "tradingview.backtest",
      "tradingview.gui",
    ],
    description: "Authorized Remote Desktop Commander fallback for bootstrap, repair, and GUI work.",
  },
  tv_bridge: {
    id: "tv_bridge",
    transport: "tv_bridge",
    tasks: ["tradingview.compile", "tradingview.backtest"],
    description: "Narrow TradingView runtime bridge for compile/backtest operations.",
  },
  coka_local: {
    id: "coka_local",
    transport: "coka",
    tasks: ["coka.sandbox"],
    description: "Current coka sandbox executor.",
  },
};
