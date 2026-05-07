import { useEffect, useRef } from "react";
import { parseScopedThreadKey } from "@t3tools/client-runtime";
import { useComposerQueueStore } from "../composerQueueStore";
import { selectThreadByRef, useStore } from "../store";
import { isLatestTurnSettled } from "../session-logic";
import { dispatchUserMessage } from "../lib/dispatchUserMessage";
import { hydrateImagesFromPersisted } from "../composerDraftStore";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

// Best-effort dispatcher for queued messages on threads the user isn't
// currently viewing. Lives at app shell level so it runs regardless of
// the current route. The active route's ChatView still owns its own
// flush — this hook deliberately skips that thread so the two paths
// don't race for the queue head.
//
// Per-thread inFlight tracking prevents double-dispatch while an in-
// progress dispatch is awaiting the API. The dispatcher resolves
// thread/project/api by ScopedThreadRef so a queued message on any
// environment dispatches as soon as that thread's last turn settles.
//
// "Best-effort" caveat: if the provider info for a queued thread's
// environment hasn't loaded yet (remote env still hydrating), the
// entry stays queued and the next render attempts again.
export function useBackgroundQueueFlusher(activeThreadKey: string | null) {
  const queueByThreadKey = useComposerQueueStore((state) => state.queueByThreadKey);
  const envRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const [threadKey, queue] of Object.entries(queueByThreadKey)) {
      if (queue.length === 0) continue;
      if (threadKey === activeThreadKey) continue;
      if (inFlightRef.current.has(threadKey)) continue;
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
      inFlightRef.current.add(threadKey);

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
          // On success, drop the in-flight entry. On failure keep the
          // entry queued so the user can see it and either retry by
          // navigating to the thread or remove it manually. After N
          // consecutive failures completeInFlight drops the entry; we
          // surface a toast so the message doesn't vanish silently.
          const completion = useComposerQueueStore
            .getState()
            .completeInFlight(threadKey, result.ok);
          surfaceDroppedQueueEntry(completion.droppedAfterRetries);
        })
        .catch(() => {
          const completion = useComposerQueueStore.getState().completeInFlight(threadKey, false);
          surfaceDroppedQueueEntry(completion.droppedAfterRetries);
        })
        .finally(() => {
          inFlightRef.current.delete(threadKey);
        });
    }
  }, [queueByThreadKey, activeThreadKey, envRuntimeById]);
}

function surfaceDroppedQueueEntry(
  entry: ReturnType<
    ReturnType<typeof useComposerQueueStore.getState>["completeInFlight"]
  >["droppedAfterRetries"],
): void {
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
