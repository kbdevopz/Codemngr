/**
 * Hydration unit tests — exercises the bridge from `ServerSettings`
 * (legacy `providers.<kind>` blobs + explicit `providerInstances`) to
 * the driver-agnostic `ProviderInstanceConfigMap` the registry consumes.
 *
 * The registry itself has its own multi-instance tests in
 * ProviderInstanceRegistryLive.test.ts; this file targets the merge
 * logic alone.
 */
import { describe, expect, it } from "vitest";
import {
  defaultInstanceIdForDriver,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const codexLegacy = { enabled: true, binaryPath: "codex" };
const claudeLegacy = { enabled: true, binaryPath: "claude" };

function makeSettings(overrides: Partial<ServerSettings>): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    ...overrides,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      ...overrides.providers,
    },
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      ...overrides.providerInstances,
    },
  } as ServerSettings;
}

describe("deriveProviderInstanceConfigMap", () => {
  it("synthesizes a default codex entry from the legacy providers.codex blob", () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, ...codexLegacy },
      },
    });
    const result = deriveProviderInstanceConfigMap(settings);
    const defaultCodexId = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
    expect(result[defaultCodexId]?.driver).toBe("codex");
  });

  it("does NOT synthesize a default codex when an explicit codex_personal instance exists", () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, ...codexLegacy },
      },
      providerInstances: {
        [ProviderInstanceId.make("codex_personal")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: true, binaryPath: "codex" },
        },
      },
    });
    const result = deriveProviderInstanceConfigMap(settings);
    const defaultCodexId = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
    expect(result[defaultCodexId]).toBeUndefined();
    expect(result[ProviderInstanceId.make("codex_personal")]?.driver).toBe("codex");
  });

  it("preserves multiple explicit codex instances and skips legacy synthesis for codex", () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, ...codexLegacy },
      },
      providerInstances: {
        [ProviderInstanceId.make("codex_work")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: true, binaryPath: "codex" },
        },
        [ProviderInstanceId.make("codex_personal")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: true, binaryPath: "codex" },
        },
      },
    });
    const result = deriveProviderInstanceConfigMap(settings);
    const codexEntries = Object.entries(result)
      .filter(([, entry]) => entry.driver === "codex")
      .map(([id]) => id)
      .toSorted();
    expect(codexEntries).toEqual(["codex_personal", "codex_work"]);
    expect(result[defaultInstanceIdForDriver(ProviderDriverKind.make("codex"))]).toBeUndefined();
  });

  it("synthesizes legacy entries only for drivers without explicit instances", () => {
    const settings = makeSettings({
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, ...codexLegacy },
        claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, ...claudeLegacy },
      },
      providerInstances: {
        [ProviderInstanceId.make("codex_only")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: true, binaryPath: "codex" },
        },
      },
    });
    const result = deriveProviderInstanceConfigMap(settings);
    const defaultClaudeId = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
    expect(result[ProviderInstanceId.make("codex_only")]?.driver).toBe("codex");
    expect(result[defaultClaudeId]?.driver).toBe("claudeAgent");
    expect(result[defaultInstanceIdForDriver(ProviderDriverKind.make("codex"))]).toBeUndefined();
  });

  it("synthesizes a default entry for every built-in driver from default settings", () => {
    const settings = makeSettings({});
    const result = deriveProviderInstanceConfigMap(settings);
    const drivers = Object.values(result)
      .map((entry) => entry.driver)
      .toSorted();
    expect(drivers).toEqual(["claudeAgent", "codex", "cursor", "opencode"]);
  });
});
