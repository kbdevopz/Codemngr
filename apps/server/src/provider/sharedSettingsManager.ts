/**
 * sharedSettingsManager — Jean-Claude-style shared `settings.json`
 * across multiple instances of the same driver.
 *
 * Each driver has a per-driver shared root at
 * `~/.codemngr/shared/<driver>/settings.json`. An instance's own
 * `<homePath>/settings.json` can be replaced with a symlink to that
 * shared file, so configuration travels across accounts without
 * mixing credentials (which live in sibling files like `auth.json`).
 *
 * Operations are deliberately scoped to the single `settings.json`
 * file. Directories (`hooks/`, `agents/`) bring per-file conflict
 * handling that's better solved by a follow-up after this lands.
 *
 * @module provider/sharedSettingsManager
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as fs from "node:fs/promises";

import type { ProviderDriverKind } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

const SHARED_ROOT = join(homedir(), ".codemngr", "shared");
const TARGET_FILENAME = "settings.json";

export interface SharedSettingsStatus {
  /** Absolute path to `<homePath>/settings.json` after tilde expansion. May not exist on disk. */
  readonly localPath: string;
  /** Absolute path the shared file would live at — may not exist if no instance has shared yet. */
  readonly sharedPath: string;
  /** True when localPath is a symlink (regardless of target). */
  readonly isSymlink: boolean;
  /** Where the symlink points. Only populated when `isSymlink` is true. */
  readonly symlinkTarget: string | null;
  /** True when the local symlink resolves to `sharedPath`. */
  readonly linkedToShared: boolean;
  /** True when the local file is a real (non-symlink) file. */
  readonly isLocalFile: boolean;
  /** True when something exists at `sharedPath`. */
  readonly sharedExists: boolean;
  /**
   * SHA-1-ish digest of file content, used to surface whether local
   * differs from shared so the UI can warn before overwriting. Null
   * when the file doesn't exist or fails to read.
   */
  readonly localContentHash: string | null;
  readonly sharedContentHash: string | null;
}

export interface SharedSettingsActionInput {
  readonly driver: ProviderDriverKind;
  readonly homePath: string;
}

export class SharedSettingsError extends Error {
  readonly code: "missing-home-path" | "local-is-symlink-elsewhere" | "fs-error";
  constructor(message: string, code: SharedSettingsError["code"]) {
    super(message);
    this.code = code;
  }
}

function sharedPathForDriver(driver: ProviderDriverKind): string {
  return join(SHARED_ROOT, String(driver), TARGET_FILENAME);
}

function localPathForHome(homePath: string): string {
  return join(resolve(expandHomePath(homePath)), TARGET_FILENAME);
}

async function readContentHash(path: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path);
    let hash = 0;
    for (let i = 0; i < buf.length; i += 1) {
      hash = (hash * 31 + buf[i]!) >>> 0;
    }
    return `${buf.length}:${hash.toString(16)}`;
  } catch {
    return null;
  }
}

export async function getSharedSettingsStatus(
  input: SharedSettingsActionInput,
): Promise<SharedSettingsStatus> {
  if (!input.homePath || input.homePath.trim().length === 0) {
    throw new SharedSettingsError(
      "Instance has no homePath; set one before sharing settings.",
      "missing-home-path",
    );
  }
  const localPath = localPathForHome(input.homePath);
  const sharedPath = sharedPathForDriver(input.driver);

  let isSymlink = false;
  let symlinkTarget: string | null = null;
  let isLocalFile = false;
  try {
    const stat = await fs.lstat(localPath);
    if (stat.isSymbolicLink()) {
      isSymlink = true;
      symlinkTarget = await fs.readlink(localPath);
    } else if (stat.isFile()) {
      isLocalFile = true;
    }
  } catch {
    // Local file does not exist; both flags stay false.
  }

  let sharedExists = false;
  try {
    const stat = await fs.lstat(sharedPath);
    sharedExists = stat.isFile() || stat.isSymbolicLink();
  } catch {
    sharedExists = false;
  }

  const resolvedSymlinkTarget =
    symlinkTarget !== null && !symlinkTarget.startsWith("/")
      ? resolve(dirname(localPath), symlinkTarget)
      : symlinkTarget;
  const linkedToShared = resolvedSymlinkTarget === sharedPath;

  const [localContentHash, sharedContentHash] = await Promise.all([
    readContentHash(localPath),
    readContentHash(sharedPath),
  ]);

  return {
    localPath,
    sharedPath,
    isSymlink,
    symlinkTarget: resolvedSymlinkTarget,
    linkedToShared,
    isLocalFile,
    sharedExists,
    localContentHash,
    sharedContentHash,
  };
}

export async function enableSharedSettings(
  input: SharedSettingsActionInput,
): Promise<SharedSettingsStatus> {
  const status = await getSharedSettingsStatus(input);

  // Already linked to shared — nothing to do.
  if (status.linkedToShared) return status;

  // Local is a symlink to something other than shared. Refuse to mess
  // with another tool's link; the user should resolve it manually.
  if (status.isSymlink && !status.linkedToShared) {
    throw new SharedSettingsError(
      `${status.localPath} already symlinks to ${status.symlinkTarget ?? "another path"}; remove or repoint it before enabling sharing.`,
      "local-is-symlink-elsewhere",
    );
  }

  await fs.mkdir(dirname(status.sharedPath), { recursive: true });

  // Seed the shared file from the local one if shared doesn't exist.
  // Otherwise we keep the existing shared content, which is what new
  // accounts joining an existing share want.
  if (!status.sharedExists && status.isLocalFile) {
    try {
      await fs.copyFile(status.localPath, status.sharedPath);
    } catch (err) {
      throw new SharedSettingsError(
        `Could not copy local settings to shared root: ${err instanceof Error ? err.message : "fs error"}`,
        "fs-error",
      );
    }
  } else if (!status.sharedExists) {
    // Neither side has content — create an empty shared file so the
    // symlink target exists.
    await fs.writeFile(status.sharedPath, "{}\n", "utf8");
  } else if (status.isLocalFile && status.localContentHash !== status.sharedContentHash) {
    // Shared exists, local exists, contents differ. Back up local
    // before overwriting it with the symlink. The .backup-<ts> sibling
    // is recoverable via "Disable sharing" + manual rename.
    const backupPath = `${status.localPath}.backup-${Date.now()}`;
    try {
      await fs.copyFile(status.localPath, backupPath);
    } catch (err) {
      throw new SharedSettingsError(
        `Could not back up local settings before linking: ${err instanceof Error ? err.message : "fs error"}`,
        "fs-error",
      );
    }
  }

  // Replace local with a symlink to shared.
  if (status.isLocalFile || status.isSymlink) {
    try {
      await fs.unlink(status.localPath);
    } catch (err) {
      throw new SharedSettingsError(
        `Could not remove existing local file: ${err instanceof Error ? err.message : "fs error"}`,
        "fs-error",
      );
    }
  }
  await fs.mkdir(dirname(status.localPath), { recursive: true });
  await fs.symlink(status.sharedPath, status.localPath);

  return getSharedSettingsStatus(input);
}

export async function disableSharedSettings(
  input: SharedSettingsActionInput,
): Promise<SharedSettingsStatus> {
  const status = await getSharedSettingsStatus(input);
  if (!status.linkedToShared) return status;

  // Read current shared content so the local file picks up where the
  // shared one left off.
  let content: Buffer;
  try {
    content = await fs.readFile(status.sharedPath);
  } catch (err) {
    throw new SharedSettingsError(
      `Could not read shared settings to materialize locally: ${err instanceof Error ? err.message : "fs error"}`,
      "fs-error",
    );
  }
  try {
    await fs.unlink(status.localPath);
  } catch (err) {
    throw new SharedSettingsError(
      `Could not remove symlink: ${err instanceof Error ? err.message : "fs error"}`,
      "fs-error",
    );
  }
  await fs.writeFile(status.localPath, content);
  return getSharedSettingsStatus(input);
}
