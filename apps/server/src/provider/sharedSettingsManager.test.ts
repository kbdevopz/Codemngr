import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  disableSharedSettings,
  enableSharedSettings,
  getSharedSettingsStatus,
  SharedSettingsError,
} from "./sharedSettingsManager.ts";

const DRIVER = ProviderDriverKind.make("claudeAgent");

async function makeTempHome(): Promise<string> {
  return await fs.mkdtemp(join(tmpdir(), "codemngr-shared-test-"));
}

async function cleanup(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
}

describe("sharedSettingsManager", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await makeTempHome();
  });

  afterEach(async () => {
    await cleanup(homePath);
    // Clean up the per-test shared file so subsequent tests start fresh.
    const sharedDir = join(homedir(), ".codemngr", "shared", DRIVER);
    await cleanup(sharedDir);
  });

  it("rejects when the home path is empty", async () => {
    await expect(getSharedSettingsStatus({ driver: DRIVER, homePath: "" })).rejects.toBeInstanceOf(
      SharedSettingsError,
    );
  });

  it("reports an unset state when the home is empty on disk", async () => {
    const status = await getSharedSettingsStatus({ driver: DRIVER, homePath });
    expect(status.isSymlink).toBe(false);
    expect(status.isLocalFile).toBe(false);
    expect(status.sharedExists).toBe(false);
    expect(status.linkedToShared).toBe(false);
  });

  it("seeds the shared file from local on first enable", async () => {
    await fs.writeFile(join(homePath, "settings.json"), '{"theme":"dark"}', "utf8");
    const result = await enableSharedSettings({ driver: DRIVER, homePath });
    expect(result.isSymlink).toBe(true);
    expect(result.linkedToShared).toBe(true);
    expect(result.sharedExists).toBe(true);
    const sharedContent = await fs.readFile(result.sharedPath, "utf8");
    expect(sharedContent).toBe('{"theme":"dark"}');
  });

  it("creates an empty shared file when neither side has content", async () => {
    const result = await enableSharedSettings({ driver: DRIVER, homePath });
    expect(result.isSymlink).toBe(true);
    expect(result.sharedExists).toBe(true);
    const sharedContent = await fs.readFile(result.sharedPath, "utf8");
    expect(sharedContent).toBe("{}\n");
  });

  it("backs up local content when local differs from shared", async () => {
    await fs.writeFile(join(homePath, "settings.json"), '{"theme":"light"}', "utf8");
    await enableSharedSettings({ driver: DRIVER, homePath });

    // Second account's local differs from the shared content.
    const homePath2 = await makeTempHome();
    try {
      await fs.writeFile(join(homePath2, "settings.json"), '{"theme":"work"}', "utf8");
      await enableSharedSettings({ driver: DRIVER, homePath: homePath2 });
      const entries = await fs.readdir(homePath2);
      expect(entries.some((entry) => entry.startsWith("settings.json.backup-"))).toBe(true);
      const after = await fs.readFile(join(homePath2, "settings.json"), "utf8");
      expect(after).toBe('{"theme":"light"}');
    } finally {
      await cleanup(homePath2);
    }
  });

  it("is idempotent when already linked", async () => {
    await fs.writeFile(join(homePath, "settings.json"), "{}", "utf8");
    await enableSharedSettings({ driver: DRIVER, homePath });
    const second = await enableSharedSettings({ driver: DRIVER, homePath });
    expect(second.linkedToShared).toBe(true);
  });

  it("refuses when the local file is a symlink to something other than the shared root", async () => {
    const outsideTarget = await makeTempHome();
    try {
      const outsideFile = join(outsideTarget, "other-settings.json");
      await fs.writeFile(outsideFile, "{}", "utf8");
      await fs.symlink(outsideFile, join(homePath, "settings.json"));
      await expect(enableSharedSettings({ driver: DRIVER, homePath })).rejects.toMatchObject({
        code: "local-is-symlink-elsewhere",
      });
    } finally {
      await cleanup(outsideTarget);
    }
  });

  it("disables sharing by replacing the symlink with a real file copy of shared content", async () => {
    await fs.writeFile(join(homePath, "settings.json"), '{"a":1}', "utf8");
    await enableSharedSettings({ driver: DRIVER, homePath });

    const disabled = await disableSharedSettings({ driver: DRIVER, homePath });
    expect(disabled.isSymlink).toBe(false);
    expect(disabled.isLocalFile).toBe(true);
    const localAfter = await fs.readFile(disabled.localPath, "utf8");
    expect(localAfter).toBe('{"a":1}');
  });

  it("disable is a no-op when not currently linked", async () => {
    await fs.writeFile(join(homePath, "settings.json"), "{}", "utf8");
    const status = await disableSharedSettings({ driver: DRIVER, homePath });
    expect(status.isLocalFile).toBe(true);
    expect(status.linkedToShared).toBe(false);
  });
});
