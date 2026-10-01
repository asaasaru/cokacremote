import type {
  BackendHealthRecord,
  BackendHealthStatus,
  BackendId,
} from "./backend-health.js";

export interface RecoveryStep {
  id: string;
  description: string;
  requiresHuman: boolean;
  preferredExecutor?: BackendId;
}

export interface RecoveryPlan {
  backend: BackendId;
  status: BackendHealthStatus;
  automaticFallbackAllowed: boolean;
  retryAutomatically: boolean;
  steps: RecoveryStep[];
}

export class RecoveryWorkflow {
  plan(record: BackendHealthRecord): RecoveryPlan {
    if (record.status === "POLICY_DENIED") {
      return {
        backend: record.backend,
        status: record.status,
        automaticFallbackAllowed: false,
        retryAutomatically: false,
        steps: [
          {
            id: "stop",
            description: "Stop execution. Do not bypass a policy denial with another backend.",
            requiresHuman: false,
          },
          {
            id: "new-approval",
            description: "Require a new bounded plan or human approval if broader scope is genuinely needed.",
            requiresHuman: true,
          },
        ],
      };
    }

    if (record.status === "AUTH_REQUIRED") {
      return {
        backend: record.backend,
        status: record.status,
        automaticFallbackAllowed: true,
        retryAutomatically: false,
        steps: [
          {
            id: "fallback",
            description: "Continue eligible work through another healthy backend.",
            requiresHuman: false,
          },
          {
            id: "operator-login",
            description: "Use an approved Remote Desktop session only to surface the provider login UI; credentials and MFA remain human-entered.",
            requiresHuman: true,
            preferredExecutor: "remote_desktop",
          },
          {
            id: "canary",
            description: "After login, verify AgentCore status and run the CPAA canary before restoring the provider.",
            requiresHuman: false,
            preferredExecutor: "agentcore.native",
          },
        ],
      };
    }

    if (record.status === "SUBSCRIPTION_REQUIRED") {
      return {
        backend: record.backend,
        status: record.status,
        automaticFallbackAllowed: true,
        retryAutomatically: false,
        steps: [
          {
            id: "disable-provider",
            description: "Keep this provider disabled until a human explicitly confirms subscription restoration.",
            requiresHuman: false,
          },
          {
            id: "fallback",
            description: "Route work to AgentCore native, TV bridge, or approved Remote Desktop according to task type.",
            requiresHuman: false,
          },
        ],
      };
    }

    if (record.status === "RATE_LIMITED") {
      return {
        backend: record.backend,
        status: record.status,
        automaticFallbackAllowed: true,
        retryAutomatically: true,
        steps: [
          {
            id: "fallback",
            description: "Use another healthy backend while the rate-limit circuit is open.",
            requiresHuman: false,
          },
          {
            id: "half-open",
            description: "Allow one health/canary attempt after retryAfter before closing the circuit.",
            requiresHuman: false,
          },
        ],
      };
    }

    if (record.status === "UNAVAILABLE") {
      const agentcore = record.backend.startsWith("agentcore.");
      return {
        backend: record.backend,
        status: record.status,
        automaticFallbackAllowed: true,
        retryAutomatically: true,
        steps: [
          {
            id: "fallback",
            description: "Use another healthy backend within the already-approved task scope.",
            requiresHuman: false,
          },
          ...(agentcore
            ? [{
                id: "repair-agentcore",
                description: "If AgentCore itself is unavailable, use approved Remote Desktop only for bootstrap/repair, then return to AgentCore.",
                requiresHuman: false,
                preferredExecutor: "remote_desktop" as const,
              }, {
                id: "canary",
                description: "Run AgentCore status and CPAA canary before restoring normal routing.",
                requiresHuman: false,
                preferredExecutor: "agentcore.native" as const,
              }]
            : []),
        ],
      };
    }

    if (record.status === "REPAIRING") {
      return {
        backend: record.backend,
        status: record.status,
        automaticFallbackAllowed: true,
        retryAutomatically: false,
        steps: [{
          id: "fallback",
          description: "Keep the repairing backend out of normal routing and use another eligible backend.",
          requiresHuman: false,
        }],
      };
    }

    return {
      backend: record.backend,
      status: record.status,
      automaticFallbackAllowed: record.status === "DEGRADED",
      retryAutomatically: record.status === "DEGRADED",
      steps: [],
    };
  }
}
