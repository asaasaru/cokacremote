import fs from "node:fs";
import path from "node:path";

import type { AppConfig } from "./config.js";

export function assertBoundedExecutableConfigured(
  config: AppConfig,
  executable: string | undefined,
): void {
  if (
    config.capabilityMode === "bounded" &&
    executable &&
    !config.boundedExecutablePaths[executable]
  ) {
    throw new Error(
      `Bounded executable ${executable} is not pinned in MCP_BOUNDED_EXECUTABLE_PATHS_JSON`,
    );
  }
}

export function resolveBoundedExecutable(
  config: AppConfig,
  executable: string,
): string {
  assertBoundedExecutableConfigured(config, executable);
  const configured = config.boundedExecutablePaths[executable];
  if (!configured) {
    throw new Error(
      `Bounded executable ${executable} is not pinned in MCP_BOUNDED_EXECUTABLE_PATHS_JSON`,
    );
  }
  const resolved = fs.realpathSync(configured);
  if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Pinned executable ${executable} does not resolve to a regular file`);
  }
  return resolved;
}
