import { createHash } from "node:crypto";

export const CONTROL_PLANE_CONTRACT_REVISION = "2026-10-03.2";
export const STABLE_CONTROL_PLANE_TOOLS = [
  "execution_request",
  "execution_status",
  "execution_route",
  "execution_recovery",
] as const;
export const CONTROL_PLANE_SCHEMA_COMPATIBILITY =
  "stable-tool-names-server-validated-values";

const contractDescriptor = {
  revision: CONTROL_PLANE_CONTRACT_REVISION,
  stableTools: STABLE_CONTROL_PLANE_TOOLS,
  compatibility: CONTROL_PLANE_SCHEMA_COMPATIBILITY,
} as const;

export const CONTROL_PLANE_CONTRACT_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(contractDescriptor))
  .digest("hex");
