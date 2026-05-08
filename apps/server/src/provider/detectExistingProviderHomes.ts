/**
 * Filesystem probe for existing provider credential directories.
 *
 * The web client can't read the user's filesystem; this helper does the
 * existence check server-side for the well-known per-provider credential
 * paths (e.g. `~/.claude`, `~/.codex`) and tags each with whether some
 * `providerInstances` entry already references it via `homePath`.
 *
 * Detection here is intentionally shallow: we only check whether the
 * directory exists, not whether it's actually authenticated. The
 * existing per-instance probe (ClaudeProvider / CodexProvider) handles
 * auth detection once an instance is configured against the path.
 *
 * @module provider/detectExistingProviderHomes
 */
import { ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";

import { expandHomePath } from "../pathExpansion.ts";

interface KnownHome {
  readonly driver: ProviderDriverKind;
  readonly path: string;
}

const KNOWN_HOMES: ReadonlyArray<KnownHome> = [
  { driver: ProviderDriverKind.make("claudeAgent"), path: "~/.claude" },
  { driver: ProviderDriverKind.make("codex"), path: "~/.codex" },
];

export interface DetectedProviderHome {
  readonly driver: ProviderDriverKind;
  readonly path: string;
  readonly resolvedPath: string;
  readonly exists: boolean;
  readonly alreadyConfigured: boolean;
}

function readConfigString(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function configuredHomePathsByDriver(
  providerInstances: Record<string, ProviderInstanceConfig>,
): Map<ProviderDriverKind, Set<string>> {
  const result = new Map<ProviderDriverKind, Set<string>>();
  for (const entry of Object.values(providerInstances)) {
    const homePath = readConfigString(entry.config, "homePath");
    if (!homePath) continue;
    const resolved = expandHomePath(homePath);
    const bucket = result.get(entry.driver) ?? new Set<string>();
    bucket.add(resolved);
    result.set(entry.driver, bucket);
  }
  return result;
}

async function pathExists(resolvedPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(resolvedPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export const detectExistingProviderHomes = (
  providerInstances: Record<string, ProviderInstanceConfig>,
): Effect.Effect<{ readonly candidates: ReadonlyArray<DetectedProviderHome> }> =>
  Effect.promise(async () => {
    const configured = configuredHomePathsByDriver(providerInstances);
    const candidates = await Promise.all(
      KNOWN_HOMES.map(async (known) => {
        const resolvedPath = expandHomePath(known.path);
        const exists = await pathExists(resolvedPath);
        const alreadyConfigured =
          (configured.get(known.driver)?.has(resolvedPath) ?? false) ||
          (configured.get(known.driver)?.has(known.path) ?? false);
        return {
          driver: known.driver,
          path: known.path,
          resolvedPath,
          exists,
          alreadyConfigured,
        };
      }),
    );
    return { candidates };
  });
