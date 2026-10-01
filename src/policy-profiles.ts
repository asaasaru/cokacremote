import type { PolicyProfile } from "./capability-policy.js";

const SANDBOX = "/work/sandbox";
const TVAUTO = "/Users/vicmac/DevMac/Biz/TVauto";

export const baseCokaProfile: PolicyProfile = {
  id: "coka-base",
  alwaysAllow: [
    { capability: "workspace.read", paths: [SANDBOX] },
    { capability: "workspace.write", paths: [SANDBOX] },
    { capability: "workspace.exec", paths: [SANDBOX], commands: ["git", "node", "npm", "python", "python3", "pytest"] },
  ],
  approvalRequired: [
    { capability: "host.read" },
    { capability: "host.write" },
    { capability: "host.exec" },
    { capability: "package.install" },
    { capability: "destructive.fs" },
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
    { capability: "host.read", paths: [TVAUTO] },
    { capability: "host.write", paths: [TVAUTO] },
    {
      capability: "host.exec",
      paths: [TVAUTO],
      commands: ["git", "node", "npm", "python", "python3", "pytest"],
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

export function getPolicyProfile(profileId: string): PolicyProfile {
  const profile = PROFILES.get(profileId);
  if (!profile) {
    throw new Error(`Unknown policy profile: ${profileId}`);
  }
  return profile;
}

export function listPolicyProfileIds(): string[] {
  return [...PROFILES.keys()];
}
