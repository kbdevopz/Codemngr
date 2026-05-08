"use client";

import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerDetectedProviderHome,
} from "@t3tools/contracts";

import { ensureLocalApi } from "../../localApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

interface DetectExistingProvidersDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const DRIVER_LABEL: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

function buildImportInstanceId(
  driver: string,
  existingIds: ReadonlySet<string>,
): ProviderInstanceId {
  const base = `${driver}_imported`;
  if (!existingIds.has(base)) return ProviderInstanceId.make(base);
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!existingIds.has(candidate)) return ProviderInstanceId.make(candidate);
  }
  // Astronomically unlikely fallback — collisions imply 100 prior imports
  // for the same driver. The branded constructor still validates the slug.
  return ProviderInstanceId.make(`${base}_${Date.now()}`);
}

export function DetectExistingProvidersDialog({
  open,
  onOpenChange,
}: DetectExistingProvidersDialogProps) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [isLoading, setIsLoading] = useState(false);
  const [candidates, setCandidates] = useState<ReadonlyArray<ServerDetectedProviderHome>>([]);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setSelectedPaths(new Set());
    void ensureLocalApi()
      .server.detectExistingProviderHomes()
      .then((result) => {
        if (cancelled) return;
        setCandidates(result.candidates);
        // Default-check the candidates that exist and aren't already configured.
        setSelectedPaths(
          new Set(
            result.candidates
              .filter((candidate) => candidate.exists && !candidate.alreadyConfigured)
              .map((candidate) => candidate.path),
          ),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not scan for existing accounts.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const togglePath = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const importableCandidates = candidates.filter(
    (candidate) => candidate.exists && !candidate.alreadyConfigured,
  );
  const handleImport = useCallback(() => {
    setIsImporting(true);
    const existingIds = new Set(Object.keys(settings.providerInstances ?? {}));
    const nextInstances: Record<string, ProviderInstanceConfig> = {
      ...settings.providerInstances,
    };
    let imported = 0;
    for (const candidate of candidates) {
      if (!selectedPaths.has(candidate.path)) continue;
      if (!candidate.exists || candidate.alreadyConfigured) continue;
      const id = buildImportInstanceId(candidate.driver, existingIds);
      existingIds.add(id);
      const driverLabel = DRIVER_LABEL[candidate.driver] ?? candidate.driver;
      nextInstances[id] = {
        driver: candidate.driver,
        enabled: true,
        displayName: `${driverLabel} (Imported)`,
        config: { homePath: candidate.path },
      };
      imported += 1;
    }
    if (imported === 0) {
      setIsImporting(false);
      onOpenChange(false);
      return;
    }
    try {
      updateSettings({ providerInstances: nextInstances });
      toastManager.add({
        type: "success",
        title: imported === 1 ? "Imported 1 account" : `Imported ${imported} accounts`,
        description: "Re-running provider checks to detect their account info.",
      });
      onOpenChange(false);
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "Could not import accounts",
        description: err instanceof Error ? err.message : "Update failed.",
      });
    } finally {
      setIsImporting(false);
    }
  }, [candidates, onOpenChange, selectedPaths, settings.providerInstances, updateSettings]);

  const importCount = importableCandidates.filter((candidate) =>
    selectedPaths.has(candidate.path),
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Detect existing accounts</DialogTitle>
          <DialogDescription>
            Codemngr scans the well-known credential paths for each supported provider. Importing
            adds an instance pointing at the existing directory — your original install isn't
            modified.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Scanning your home directory…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No credential directories were found in any of the well-known paths.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {candidates.map((candidate) => {
                const driverLabel = DRIVER_LABEL[candidate.driver] ?? candidate.driver;
                const isSelected = selectedPaths.has(candidate.path);
                const isDisabled = !candidate.exists || candidate.alreadyConfigured;
                return (
                  <li
                    key={candidate.path}
                    className="flex items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2"
                  >
                    <Checkbox
                      checked={isSelected}
                      disabled={isDisabled}
                      onCheckedChange={() => togglePath(candidate.path)}
                      aria-label={`Import ${driverLabel} account at ${candidate.path}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{driverLabel}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {candidate.path}
                      </div>
                    </div>
                    {!candidate.exists ? (
                      <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
                        Not found
                      </span>
                    ) : candidate.alreadyConfigured ? (
                      <span className="flex items-center gap-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
                        <CheckIcon className="size-3" aria-hidden="true" /> Already imported
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={isImporting || importCount === 0}>
            {importCount === 0
              ? "Import"
              : importCount === 1
                ? "Import 1 account"
                : `Import ${importCount} accounts`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
