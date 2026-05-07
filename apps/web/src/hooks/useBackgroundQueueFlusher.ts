import { useEffect } from "react";
import { parseScopedThreadKey } from "@t3tools/client-runtime";
import { useComposerQueueStore, type QueuedMessageEntry } from "../composerQueueStore";
import { selectThreadByRef, useStore } from "../store";
import { isLatestTurnSettled } from "../session-logic";
import { dispatchUserMessage } from "../lib/dispatchUserMessage";
import { hydrateImagesFromPersisted } from "../composerDraftStore";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

// Best-effort dispatcher for queued messages on threads the user isn't
// currently viewing. Lives at app shell level. Dedup against the active
// route's ChatView flush relies on the queue store's atomic
// beginInFlight (returns null if a slot is already occupied), so two
// flushers can't take the same head.
//
// Skipped silently when the queued thread's environment hasn't loaded
// its provider list yet — the entry stays queued and the next render
// attempts again.
export function useBackgroundQueueFlusher(activeThreadKey: string | null) {
  const queueByThreadKey = useComposerQueueStore((state) => state.queueByThreadKey);
  const envRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);

  useEffect(() => {
    for (const [threadKey, queue] of Object.entries(queueByThreadKey)) {
      if (queue.length === 0) continue;
      if (threadKey === activeThreadKey) continue;
      const threadRef = parseScopedThreadKey(threadKey);
      if (!threadRef) continue;
      const state = useStore.getState();
      const thread = selectThreadByRef(state, threadRef);
      if (!thread) continue;
      if (!isLatestTurnSettled(thread.latestTurn ?? null, thread.session ?? null)) {
        continue;
      }
      const providerStatuses = envRuntimeById[threadRef.environmentId]?.serverConfig?.providers;
      if (!providerStatuses) continue;
      const head = queue[0];
      if (!head) continue;
      const modelSelection = head.modelSelection ?? thread.modelSelection;
      const providerEntry = providerStatuses.find(
        (entry) => entry.instanceId === modelSelection.instanceId,
      );
      if (!providerEntry) continue;

      const taken = useComposerQueueStore.getState().beginInFlight(threadKey);
      if (!taken) continue;

      const hydratedImages = taken.images ? hydrateImagesFromPersisted(taken.images) : [];
      const queuedTerminalContexts = [...(taken.terminalContexts ?? [])];
      const dispatchModelSelection = taken.modelSelection ?? thread.modelSelection;

      void dispatchUserMessage({
        threadRef,
        text: taken.text,
        trimmed: taken.text,
        images: hydratedImages,
        terminalContexts: queuedTerminalContexts,
        expiredTerminalContextCount: 0,
        selectedModelSelection: dispatchModelSelection,
        selectedProvider: providerEntry.driver,
        selectedModel: dispatchModelSelection.model ?? "",
        selectedProviderModels: providerEntry.models,
        selectedPromptEffort: null,
        runtimeMode: taken.runtimeMode ?? thread.runtimeMode,
        interactionMode: taken.interactionMode ?? thread.interactionMode,
      })
        .then((result) => {
          const completion = useComposerQueueStore
            .getState()
            .completeInFlight(threadKey, result.ok);
          surfaceDroppedQueueEntry(completion.droppedAfterRetries);
        })
        .catch(() => {
          const completion = useComposerQueueStore.getState().completeInFlight(threadKey, false);
          surfaceDroppedQueueEntry(completion.droppedAfterRetries);
        });
    }
  }, [queueByThreadKey, activeThreadKey, envRuntimeById]);
}

export function surfaceDroppedQueueEntry(entry: QueuedMessageEntry | null): void {
  if (!entry) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Queued message dropped after repeated failures",
      description:
        entry.text.length > 0
          ? entry.text
          : "Message had no text. Re-queue from history if needed.",
    }),
  );
}
