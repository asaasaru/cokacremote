import { randomUUID } from "node:crypto";

import type { BackendId } from "./backend-health.js";

export type AgentCoreBackend = Extract<BackendId, "agentcore.native" | "agentcore.antigravity">;
export type AgentCorePlatform = "macos" | "windows";

export interface AgentCoreProjectRegistration {
  projectId: string;
  root: string;
}

export interface AgentCoreDeviceRegistration {
  deviceId: string;
  platform: AgentCorePlatform;
  version: string;
  fingerprint: string;
  projects: AgentCoreProjectRegistration[];
  backends: AgentCoreBackend[];
  registeredAt: number;
  lastSeenAt: number;
}

export type AgentCoreJobStatus =
  | "queued"
  | "leased"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "expired";

export interface AgentCoreSafeResult {
  summary?: string;
  output?: string;
  facts?: string[];
  changedPaths?: string[];
  deniedActions?: string[];
  evidencePaths?: string[];
  testsPassed?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export type AgentCoreReadOperation = "stat" | "sha256" | "text" | "git_status";

export interface AgentCoreJobRequest {
  subjectId: string;
  backend: AgentCoreBackend;
  projectId: string;
  task: string;
  capability: string;
  path?: string;
  command?: { executable: string; args: string[] };
  networkTarget?: string;
  actionDigest: string;
  probeRequired: boolean;
  readOperation?: AgentCoreReadOperation;
  maxBytes?: number;
  planId?: string;
  planSha256?: string;
  instruction?: string;
  testIds?: string[];
}

export interface AgentCoreJob extends AgentCoreJobRequest {
  requestId: string;
  deviceId: string;
  projectRoot: string;
  status: AgentCoreJobStatus;
  issuedAt: number;
  expiresAt: number;
  leasedAt?: number;
  completedAt?: number;
  result?: AgentCoreSafeResult;
}

function normalizeHostPath(platform: AgentCorePlatform, value: string): string {
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (platform === "windows") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function pathWithin(platform: AgentCorePlatform, root: string, target: string): boolean {
  const base = normalizeHostPath(platform, root);
  const value = normalizeHostPath(platform, target);
  return value === base || value.startsWith(`${base}/`);
}

function cloneDevice(device: AgentCoreDeviceRegistration): AgentCoreDeviceRegistration {
  return {
    ...device,
    projects: device.projects.map((project) => ({ ...project })),
    backends: [...device.backends],
  };
}

function cloneJob(job: AgentCoreJob): AgentCoreJob {
  return {
    ...job,
    command: job.command
      ? { executable: job.command.executable, args: [...job.command.args] }
      : undefined,
    testIds: job.testIds ? [...job.testIds] : undefined,
    result: job.result
      ? {
          ...job.result,
          facts: job.result.facts ? [...job.result.facts] : undefined,
          changedPaths: job.result.changedPaths ? [...job.result.changedPaths] : undefined,
          deniedActions: job.result.deniedActions ? [...job.result.deniedActions] : undefined,
          evidencePaths: job.result.evidencePaths ? [...job.result.evidencePaths] : undefined,
        }
      : undefined,
  };
}

export class AgentCoreBroker {
  private readonly devices = new Map<string, AgentCoreDeviceRegistration>();
  private readonly jobs = new Map<string, AgentCoreJob>();

  constructor(
    private readonly configuredDeviceIds: ReadonlySet<string>,
    private readonly deviceStaleMs = 90_000,
    private readonly jobTtlMs = 15 * 60_000,
    private readonly completedRetentionMs = 60 * 60_000,
    private readonly maxJobs = 1_000,
  ) {}

  enabled(): boolean {
    return this.configuredDeviceIds.size > 0;
  }

  register(
    input: Omit<AgentCoreDeviceRegistration, "registeredAt" | "lastSeenAt">,
    now = Date.now(),
  ): AgentCoreDeviceRegistration {
    if (!this.configuredDeviceIds.has(input.deviceId)) {
      throw new Error("AgentCore device is not configured");
    }
    const previous = this.devices.get(input.deviceId);
    const device: AgentCoreDeviceRegistration = {
      ...input,
      projects: input.projects.map((project) => ({ ...project })),
      backends: [...input.backends],
      registeredAt: previous?.registeredAt ?? now,
      lastSeenAt: now,
    };
    this.devices.set(device.deviceId, device);
    return cloneDevice(device);
  }

  heartbeat(deviceId: string, now = Date.now()): AgentCoreDeviceRegistration {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error("AgentCore device is not registered");
    }
    device.lastSeenAt = now;
    return cloneDevice(device);
  }

  activeDevices(now = Date.now()): AgentCoreDeviceRegistration[] {
    return [...this.devices.values()]
      .filter((device) => now - device.lastSeenAt <= this.deviceStaleMs)
      .map(cloneDevice);
  }

  registeredDevices(now = Date.now()): AgentCoreDeviceRegistration[] {
    return [...this.devices.values()].map((device) => ({
      ...cloneDevice(device),
      backends:
        now - device.lastSeenAt <= this.deviceStaleMs ? [...device.backends] : [],
    }));
  }

  private candidates(
    backend: AgentCoreBackend,
    projectId: string,
    targetPath: string | undefined,
    now: number,
  ): Array<{ device: AgentCoreDeviceRegistration; project: AgentCoreProjectRegistration }> {
    return this.activeDevices(now)
      .filter((device) => device.backends.includes(backend))
      .flatMap((device) =>
        device.projects
          .filter(
            (project) =>
              project.projectId === projectId &&
              (!targetPath || pathWithin(device.platform, project.root, targetPath)),
          )
          .map((project) => ({ device, project })),
      )
      .sort((a, b) => b.device.lastSeenAt - a.device.lastSeenAt);
  }

  canRoute(
    backend: AgentCoreBackend,
    projectId: string,
    targetPath?: string,
    now = Date.now(),
  ): boolean {
    return this.candidates(backend, projectId, targetPath, now).length > 0;
  }

  enqueue(request: AgentCoreJobRequest, now = Date.now()): AgentCoreJob {
    this.prune(now);
    const selected = this.candidates(request.backend, request.projectId, request.path, now)[0];
    if (!selected) {
      throw new Error(
        `No active AgentCore device is registered for ${request.backend} project=${request.projectId}`,
      );
    }
    if (this.jobs.size >= this.maxJobs) {
      throw new Error("AgentCore broker job capacity reached");
    }
    const job: AgentCoreJob = {
      ...request,
      command: request.command
        ? { executable: request.command.executable, args: [...request.command.args] }
        : undefined,
      testIds: request.testIds ? [...request.testIds] : undefined,
      requestId: randomUUID(),
      deviceId: selected.device.deviceId,
      projectRoot: selected.project.root,
      status: "queued",
      issuedAt: now,
      expiresAt: now + this.jobTtlMs,
    };
    this.jobs.set(job.requestId, job);
    return cloneJob(job);
  }

  poll(deviceId: string, now = Date.now()): AgentCoreJob | undefined {
    this.heartbeat(deviceId, now);
    this.prune(now);
    const job = [...this.jobs.values()]
      .filter((candidate) => candidate.deviceId === deviceId && candidate.status === "queued")
      .sort((a, b) => a.issuedAt - b.issuedAt)[0];
    if (!job) {
      return undefined;
    }
    job.status = "leased";
    job.leasedAt = now;
    return cloneJob(job);
  }

  complete(
    deviceId: string,
    requestId: string,
    status: Extract<AgentCoreJobStatus, "completed" | "failed" | "blocked" | "cancelled">,
    result: AgentCoreSafeResult,
    now = Date.now(),
  ): AgentCoreJob {
    this.heartbeat(deviceId, now);
    const job = this.jobs.get(requestId);
    if (!job || job.deviceId !== deviceId) {
      throw new Error("Unknown AgentCore job");
    }
    if (job.status !== "queued" && job.status !== "leased") {
      throw new Error(`AgentCore job is already ${job.status}`);
    }
    job.status = status;
    job.result = {
      ...result,
      facts: result.facts ? [...result.facts] : undefined,
      changedPaths: result.changedPaths ? [...result.changedPaths] : undefined,
      deniedActions: result.deniedActions ? [...result.deniedActions] : undefined,
      evidencePaths: result.evidencePaths ? [...result.evidencePaths] : undefined,
    };
    job.completedAt = now;
    return cloneJob(job);
  }

  getForSubject(requestId: string, subjectId: string, now = Date.now()): AgentCoreJob | undefined {
    this.prune(now);
    const job = this.jobs.get(requestId);
    if (!job || job.subjectId !== subjectId) {
      return undefined;
    }
    return cloneJob(job);
  }

  getForDevice(requestId: string, deviceId: string, now = Date.now()): AgentCoreJob | undefined {
    this.prune(now);
    const job = this.jobs.get(requestId);
    if (!job || job.deviceId !== deviceId) {
      return undefined;
    }
    return cloneJob(job);
  }

  prune(now = Date.now()): void {
    for (const job of this.jobs.values()) {
      if ((job.status === "queued" || job.status === "leased") && job.expiresAt <= now) {
        job.status = "expired";
        job.completedAt = now;
      }
      if (
        job.completedAt !== undefined &&
        now - job.completedAt > this.completedRetentionMs
      ) {
        this.jobs.delete(job.requestId);
      }
    }
  }
}
