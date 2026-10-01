import path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import type { CapabilityGrant, CapabilityRequest } from "./capability-policy.js";

export interface CapabilityTicketPayload {
  version: 1;
  ticketId: string;
  grantId: string;
  subjectId: string;
  projectId: string;
  capability: CapabilityRequest["capability"];
  actionDigest: string;
  issuedAt: number;
  expiresAt: number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function normalizedAction(request: CapabilityRequest): Record<string, unknown> {
  return {
    capability: request.capability,
    command: request.command
      ? {
          executable: request.command.executable,
          args: request.command.args ?? [],
        }
      : undefined,
    networkTarget: request.networkTarget,
    path: request.path,
    projectId: request.projectId,
    subjectId: request.subjectId,
  };
}

export function actionDigest(request: CapabilityRequest): string {
  return createHash("sha256").update(canonical(normalizedAction(request))).digest("hex");
}

function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function keyObject(key: string | Buffer | KeyObject, kind: "private" | "public"): KeyObject {
  if (typeof key !== "string" && !Buffer.isBuffer(key)) {
    return key;
  }
  return kind === "private" ? createPrivateKey(key) : createPublicKey(key);
}

function isWithin(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function grantCoversRequest(grant: CapabilityGrant, request: CapabilityRequest, now: number): boolean {
  if (
    grant.issuedBy !== "human" ||
    grant.revokedAt !== undefined ||
    grant.expiresAt <= now ||
    grant.uses > grant.maxUses ||
    grant.subjectId !== request.subjectId ||
    grant.projectId !== request.projectId ||
    !grant.capabilities.includes(request.capability)
  ) {
    return false;
  }
  if (
    grant.paths?.length &&
    (!request.path || !grant.paths.some((root) => isWithin(request.path!, root)))
  ) {
    return false;
  }
  if (
    grant.commands?.length &&
    (!request.command || !grant.commands.includes(path.basename(request.command.executable)))
  ) {
    return false;
  }
  if (
    grant.networkTargets?.length &&
    (!request.networkTarget || !grant.networkTargets.includes(request.networkTarget))
  ) {
    return false;
  }
  return true;
}

export function issueCapabilityTicket(options: {
  grant: CapabilityGrant;
  request: CapabilityRequest;
  privateKey: string | Buffer | KeyObject;
  ticketId: string;
  now?: number;
  ttlMs?: number;
}): string {
  const now = options.now ?? Date.now();
  const ttlMs = Math.min(Math.max(1, options.ttlMs ?? 30_000), 60_000);
  if (!grantCoversRequest(options.grant, options.request, now)) {
    throw new Error("Grant does not cover the requested host action");
  }

  const payload: CapabilityTicketPayload = {
    version: 1,
    ticketId: options.ticketId,
    grantId: options.grant.grantId,
    subjectId: options.request.subjectId,
    projectId: options.request.projectId,
    capability: options.request.capability,
    actionDigest: actionDigest(options.request),
    issuedAt: now,
    expiresAt: Math.min(options.grant.expiresAt, now + ttlMs),
  };
  const encodedPayload = encodeBase64Url(canonical(payload));
  const signature = sign(null, Buffer.from(encodedPayload), keyObject(options.privateKey, "private"));
  return `${encodedPayload}.${encodeBase64Url(signature)}`;
}

export function verifyCapabilityTicket(options: {
  ticket: string;
  request: CapabilityRequest;
  publicKey: string | Buffer | KeyObject;
  now?: number;
}): CapabilityTicketPayload {
  const now = options.now ?? Date.now();
  const parts = options.ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Malformed capability ticket");
  }
  const [encodedPayload, encodedSignature] = parts;

  const valid = verify(
    null,
    Buffer.from(encodedPayload),
    keyObject(options.publicKey, "public"),
    decodeBase64Url(encodedSignature),
  );
  if (!valid) {
    throw new Error("Invalid capability ticket signature");
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8")) as CapabilityTicketPayload;
  if (payload.version !== 1) {
    throw new Error("Unsupported capability ticket version");
  }
  if (payload.expiresAt <= now) {
    throw new Error("Capability ticket expired");
  }
  if (
    payload.subjectId !== options.request.subjectId ||
    payload.projectId !== options.request.projectId ||
    payload.capability !== options.request.capability ||
    payload.actionDigest !== actionDigest(options.request)
  ) {
    throw new Error("Capability ticket does not match requested host action");
  }
  return payload;
}

export class CapabilityTicketReplayGuard {
  private readonly seen = new Map<string, number>();

  consume(ticketId: string, expiresAt: number, now = Date.now()): void {
    for (const [id, expiry] of this.seen) {
      if (expiry <= now) {
        this.seen.delete(id);
      }
    }
    if (this.seen.has(ticketId)) {
      throw new Error("Capability ticket replay detected");
    }
    if (expiresAt <= now) {
      throw new Error("Capability ticket expired");
    }
    this.seen.set(ticketId, expiresAt);
  }
}
