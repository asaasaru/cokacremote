import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AgentCoreBroker } from "./agentcore-broker.js";
import { ApprovalBroker } from "./approval-broker.js";
import { registerApprovalTools } from "./approval-tools.js";
import { BackendHealthRegistry } from "./backend-health.js";
import { BackendCircuitBreaker } from "./circuit-breaker.js";
import { CapabilityGate } from "./capability-gate.js";
import type { AppConfig } from "./config.js";
import { registerExecutionTools } from "./execution-tools.js";
import { FallbackPolicy } from "./fallback-policy.js";
import { registerExecTools } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { registerFileTools } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import { RecoveryWorkflow } from "./recovery-workflow.js";

export interface McpServices {
  processManager: ProcessManager;
  fileService: FileService;
  approvalBroker: ApprovalBroker;
  agentcoreBroker: AgentCoreBroker;
  health: BackendHealthRegistry;
  circuits: BackendCircuitBreaker;
  fallback: FallbackPolicy;
  recovery: RecoveryWorkflow;
  capabilityGate: CapabilityGate;
}

export function createServices(config: AppConfig): McpServices {
  const health = new BackendHealthRegistry();
  health.markHealthy("coka_local");
  const approvalBroker = new ApprovalBroker();
  const agentcoreBroker = new AgentCoreBroker(
    new Set(Object.keys(config.agentcoreDeviceKeys)),
    config.agentcoreDeviceStaleMs,
    config.agentcoreJobTtlMs,
  );
  const capabilityGate = new CapabilityGate(config, approvalBroker);
  return {
    processManager: new ProcessManager({
      maxRetainedOutputBytes: config.maxRetainedProcessOutputBytes,
      processRetentionMs: config.processRetentionMs,
      maxProcesses: config.maxProcesses,
      defaultMaxOutputBytes: config.maxOutputBytes,
    }),
    fileService: new FileService({
      defaultCwd: config.defaultCwd,
      maxChunkBytes: config.maxFileChunkBytes,
      maxEditFileBytes: config.maxEditFileBytes,
      maxOutputBytes: config.maxOutputBytes,
    }),
    approvalBroker,
    agentcoreBroker,
    health,
    circuits: new BackendCircuitBreaker(),
    fallback: new FallbackPolicy(),
    recovery: new RecoveryWorkflow(),
    capabilityGate,
  };
}

export function createMcpServer(config: AppConfig, services: McpServices): McpServer {
  const server = new McpServer(
    {
      name: "cokacremote",
      version: "0.1.0",
    },
    {
      instructions:
        "This server exposes development tools plus bounded capability approval and execution-routing diagnostics. Capability policy decisions and verified backend health must not be bypassed. execution_route is advisory/read-only: it does not execute work, approve requests, or let callers mark backends healthy.",
      capabilities: { logging: {} },
    },
  );

  registerApprovalTools(server, config, services.approvalBroker);
  registerExecutionTools(server, config, services.approvalBroker, {
    health: services.health,
    circuits: services.circuits,
    fallback: services.fallback,
    recovery: services.recovery,
    agentcoreBroker: services.agentcoreBroker,
  });
  registerExecTools(
    server,
    config,
    services.processManager,
    services.fileService,
    services.capabilityGate,
  );
  registerFileTools(server, config, services.fileService, services.capabilityGate);
  return server;
}
