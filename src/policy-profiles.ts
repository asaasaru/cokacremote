import type { PolicyProfile } from "./capability-policy.js";

const SANDBOX = "/work/sandbox";
const TVAUTO = "/Users/vicmac/DevMac/Biz/TVauto";
const EXECUTABLES = ["git", "node", "npm", "python", "python3", "pytest"];

export const baseCokaProfile: PolicyProfile = {
  id: "coka-base",
  alwaysAllow: [
    { capability: "workspace.read", paths: [SANDBOX] },
    { capability: "workspace.write", paths: [SANDBOX] },
  ],
  approvalRequired: [
    { capability: "workspace.exec", paths: [SANDBOX], commands: EXECUTABLES },
  ],
  hardDeny: [
    { capability: "real_trading" },
    { capability: "secrets.read" },
    { capability: "docker.socket" },
    { capability: "browser.personal_profile" },
    { capability: "host.unrestricted" },
  ],
};

export const pineTvautoProfile: PolicyProfile = {
  id: "pine-tvauto",
  alwaysAllow: [...baseCokaProfile.alwaysAllow],
  approvalRequired: [
    { capability: "workspace.exec", paths: [SANDBOX], commands: EXECUTABLES },
    { capability: "host.read", paths: [TVAUTO] },
    { capability: "host.write", paths: [TVAUTO] },
    { capability: "destructive.fs", paths: [TVAUTO] },
    { capability: "package.install", paths: [TVAUTO] },
    {
      capability: "host.exec",
      paths: [TVAUTO],
      commands: EXECUTABLES,
    },
    { capability: "tradingview.app" },
    {
      capability: "tradingview.cdp",
      networkTargets: ["127.0.0.1:9229", "127.0.0.1:9333", "127.0.0.1:9222"],
    },
    { capability: "loopback.http", networkTargets: ["127.0.0.1:5300"] },
  ],
  hardDeny: [...baseCokaProfile.hardDeny],
};

const PROFILES = new Map<string, PolicyProfile>([
  [baseCokaProfile.id, baseCokaProfile],
  [pineTvautoProfile.id, pineTvautoProfile],
]);

export function getPolicyProfile(
  profileId: string,
  capabilityHostRoots: string[] = [],
): PolicyProfile {
  if (profileId === baseCokaProfile.id) {
    const hostTemplates = pineTvautoProfile.approvalRequired.filter(
      (rule) => rule.paths?.includes(TVAUTO),
    );
    const hostRules = capabilityHostRoots.flatMap((root) =>
      hostTemplates.map((rule) => ({ ...rule, paths: [root] })),
    );
    return {
      ...baseCokaProfile,
      approvalRequired: [...baseCokaProfile.approvalRequired, ...hostRules],
    };
  }

  const profile = PROFILES.get(profileId);
  if (!profile) {
    throw new Error(`Unknown policy profile: ${profileId}`);
  }
  return profile;
}

export function listPolicyProfileIds(): string[] {
  return [...PROFILES.keys()];
}
