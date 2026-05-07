import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";
import type { PersistedComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";

// Per-thread queue of messages waiting to be sent while a turn is in
// progress. Each entry carries the prompt text plus a snapshot of any
// images and terminal contexts captured at enqueue time, so a queued
// message can be dispatched even after the user has cleared the
// composer or attached different content.
//
// Persistence: queues survive reload via localStorage with a debounced
// writer (300ms). On unload we flush so an in-flight write doesn't drop
// queued messages. Stale queues for deleted threads are not pruned
// automatically yet; callers can call clearForThread on thread.deleted.

export const COMPOSER_QUEUE_STORAGE_KEY = "codemngr:composer-queue:v1";
const COMPOSER_QUEUE_STORAGE_VERSION = 1;
const COMPOSER_QUEUE_PERSIST_DEBOUNCE_MS = 300;

// Hard caps so the queue can't grow without bound and exhaust localStorage.
// Background flush tends to drain queues quickly, so these limits should
// only kick in for pathological use (e.g. user pastes 50 messages in a row).
export const COMPOSER_QUEUE_MAX_ENTRIES_PER_THREAD = 25;
export const COMPOSER_QUEUE_MAX_ENTRY_BYTES = 2 * 1024 * 1024; // 2 MB per entry

// After this many consecutive dispatch failures the entry is dropped and
// the caller is notified instead of re-queueing forever.
export const COMPOSER_QUEUE_MAX_FAILURE_COUNT = 3;

const composerQueueDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  COMPOSER_QUEUE_PERSIST_DEBOUNCE_MS,
);

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    composerQueueDebouncedStorage.flush();
  });
}

export interface QueuedMessageEntry {
  id: string;
  text: string;
  createdAt: string;
  /**
   * Image attachments captured at enqueue time. Persisted as data URLs
   * (the same shape composerDraftStore uses) so they survive reload.
   */
  images?: ReadonlyArray<PersistedComposerImageAttachment>;
  /**
   * Terminal contexts captured at enqueue time. May be empty. Filtered
   * to non-expired contexts at the call site before enqueueing.
   */
  terminalContexts?: ReadonlyArray<TerminalContextDraft>;
  /**
   * Model + runtime + interaction snapshot taken at enqueue time. On
   * flush we restore these into the composer's draft store before the
   * dispatch, so a message queued with provider/model/effort A still
   * runs with A even if the user switched to B in the meantime.
   */
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  /**
   * Incremented each time a dispatch attempt fails and the entry is
   * re-queued. After COMPOSER_QUEUE_MAX_FAILURE_COUNT, the entry is
   * dropped instead and completeInFlight returns the dropped entry so
   * the caller can surface a notification.
   */
  failureCount?: number;
}

export type EnqueueFailureReason = "queue-full" | "entry-too-large";
export type EnqueueResult = { ok: true } | { ok: false; reason: EnqueueFailureReason };

export interface ComposerQueueStoreState {
  queueByThreadKey: Record<string, ReadonlyArray<QueuedMessageEntry>>;
  /**
   * Per-thread "currently dispatching" slot. The entry has been popped
   * from queueByThreadKey and an API call is in flight. Persisted so a
   * reload mid-dispatch puts the entry back in the queue rather than
   * losing it. completeInFlight clears this on success, or moves the
   * entry back to the queue head on failure.
   */
  inFlightByThreadKey: Record<string, QueuedMessageEntry>;
  enqueue: (threadKey: string, entry: QueuedMessageEntry) => EnqueueResult;
  removeEntry: (threadKey: string, entryId: string) => void;
  /**
   * Atomically pops the head off the queue and stores it in the in-flight
   * slot. Returns null if the queue is empty or the in-flight slot for
   * that thread is already occupied. The caller MUST eventually call
   * completeInFlight for that thread to release the slot.
   */
  beginInFlight: (threadKey: string) => QueuedMessageEntry | null;
  /**
   * Called when the dispatch finishes. On success, drops the in-flight
   * entry. On failure, increments the failureCount and prepends back to
   * the queue head. After COMPOSER_QUEUE_MAX_FAILURE_COUNT failures the
   * entry is dropped and returned via the result so the caller can
   * notify the user that it was abandoned.
   */
  completeInFlight: (
    threadKey: string,
    success: boolean,
  ) => { droppedAfterRetries: QueuedMessageEntry | null };
  clearForThread: (threadKey: string) => void;
  reorder: (threadKey: string, fromIndex: number, toIndex: number) => void;
}

function approximateEntryBytes(entry: QueuedMessageEntry): number {
  let bytes = entry.text.length * 2;
  if (entry.images) {
    for (const image of entry.images) {
      bytes += image.dataUrl.length;
    }
  }
  if (entry.terminalContexts) {
    for (const context of entry.terminalContexts) {
      bytes += context.text.length * 2;
    }
  }
  return bytes;
}

export const useComposerQueueStore = create<ComposerQueueStoreState>()(
  persist(
    (set, get) => ({
      queueByThreadKey: {},
      inFlightByThreadKey: {},
      enqueue: (threadKey, entry) => {
        if (approximateEntryBytes(entry) > COMPOSER_QUEUE_MAX_ENTRY_BYTES) {
          return { ok: false, reason: "entry-too-large" };
        }
        const current = get().queueByThreadKey[threadKey] ?? [];
        if (current.length >= COMPOSER_QUEUE_MAX_ENTRIES_PER_THREAD) {
          return { ok: false, reason: "queue-full" };
        }
        set((state) => {
          const existing = state.queueByThreadKey[threadKey] ?? [];
          return {
            queueByThreadKey: {
              ...state.queueByThreadKey,
              [threadKey]: [...existing, entry],
            },
          };
        });
        return { ok: true };
      },
      removeEntry: (threadKey, entryId) => {
        set((state) => {
          const existing = state.queueByThreadKey[threadKey];
          if (!existing) return state;
          const next = existing.filter((entry) => entry.id !== entryId);
          const { [threadKey]: _removed, ...rest } = state.queueByThreadKey;
          if (next.length === 0) {
            return { queueByThreadKey: rest };
          }
          return { queueByThreadKey: { ...rest, [threadKey]: next } };
        });
      },
      beginInFlight: (threadKey) => {
        const state = get();
        if (state.inFlightByThreadKey[threadKey]) return null;
        const existing = state.queueByThreadKey[threadKey];
        const head = existing?.[0] ?? null;
        if (!head) return null;
        set((current) => {
          const queue = current.queueByThreadKey[threadKey];
          if (!queue || queue.length === 0) return current;
          const [, ...rest] = queue;
          const { [threadKey]: _removed, ...others } = current.queueByThreadKey;
          const nextQueue = rest.length === 0 ? others : { ...others, [threadKey]: rest };
          return {
            queueByThreadKey: nextQueue,
            inFlightByThreadKey: { ...current.inFlightByThreadKey, [threadKey]: head },
          };
        });
        return head;
      },
      completeInFlight: (threadKey, success) => {
        const inFlight = get().inFlightByThreadKey[threadKey];
        if (!inFlight) return { droppedAfterRetries: null };
        const nextFailureCount = (inFlight.failureCount ?? 0) + 1;
        const shouldDrop = !success && nextFailureCount > COMPOSER_QUEUE_MAX_FAILURE_COUNT;
        set((state) => {
          const { [threadKey]: _removed, ...nextInFlight } = state.inFlightByThreadKey;
          if (success || shouldDrop) {
            return { inFlightByThreadKey: nextInFlight };
          }
          const existingQueue = state.queueByThreadKey[threadKey] ?? [];
          const requeued: QueuedMessageEntry = {
            ...inFlight,
            failureCount: nextFailureCount,
          };
          return {
            inFlightByThreadKey: nextInFlight,
            queueByThreadKey: {
              ...state.queueByThreadKey,
              [threadKey]: [requeued, ...existingQueue],
            },
          };
        });
        return { droppedAfterRetries: shouldDrop ? inFlight : null };
      },
      clearForThread: (threadKey) => {
        set((state) => {
          const hasQueue = Boolean(state.queueByThreadKey[threadKey]);
          const hasInFlight = Boolean(state.inFlightByThreadKey[threadKey]);
          if (!hasQueue && !hasInFlight) return state;
          const { [threadKey]: _q, ...nextQueue } = state.queueByThreadKey;
          const { [threadKey]: _f, ...nextInFlight } = state.inFlightByThreadKey;
          return { queueByThreadKey: nextQueue, inFlightByThreadKey: nextInFlight };
        });
      },
      reorder: (threadKey, fromIndex, toIndex) => {
        set((state) => {
          const existing = state.queueByThreadKey[threadKey];
          if (!existing) return state;
          if (fromIndex < 0 || fromIndex >= existing.length) return state;
          const clampedTo = Math.max(0, Math.min(toIndex, existing.length - 1));
          if (clampedTo === fromIndex) return state;
          const next = [...existing];
          const [moved] = next.splice(fromIndex, 1);
          if (!moved) return state;
          next.splice(clampedTo, 0, moved);
          return {
            queueByThreadKey: { ...state.queueByThreadKey, [threadKey]: next },
          };
        });
      },
    }),
    {
      name: COMPOSER_QUEUE_STORAGE_KEY,
      version: COMPOSER_QUEUE_STORAGE_VERSION,
      storage: createJSONStorage(() => composerQueueDebouncedStorage),
      partialize: (state) => ({
        queueByThreadKey: state.queueByThreadKey,
        inFlightByThreadKey: state.inFlightByThreadKey,
      }),
      // On reload, any persisted in-flight entry was mid-dispatch when the
      // tab closed. We can't tell whether the server actually received it,
      // so we put it back at the front of the queue. The trade-off: if the
      // dispatch DID reach the server, the next flush will send a near-
      // duplicate. We bias toward this over silent loss because the user
      // can see and remove a duplicate but can't recover a lost message.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const inFlight = state.inFlightByThreadKey ?? {};
        if (Object.keys(inFlight).length === 0) return;
        const nextQueue = { ...state.queueByThreadKey };
        for (const [threadKey, entry] of Object.entries(inFlight)) {
          const existing = nextQueue[threadKey] ?? [];
          nextQueue[threadKey] = [entry, ...existing];
        }
        state.queueByThreadKey = nextQueue;
        state.inFlightByThreadKey = {};
      },
    },
  ),
);

export function useQueuedMessagesForThread(threadKey: string): ReadonlyArray<QueuedMessageEntry> {
  return useComposerQueueStore((store) => store.queueByThreadKey[threadKey] ?? EMPTY_QUEUE);
}

export function useQueueHeadIdForThread(threadKey: string): string | null {
  return useComposerQueueStore((store) => store.queueByThreadKey[threadKey]?.[0]?.id ?? null);
}

export function useInFlightEntryForThread(threadKey: string): QueuedMessageEntry | null {
  return useComposerQueueStore((store) => store.inFlightByThreadKey[threadKey] ?? null);
}

// Returns a {threadKey: headId} map for every thread (other than
// excludeThreadKey) with at least one queued entry. Subscribers can
// pair this with useShallow so the hook only re-runs when a thread's
// queue head changes — not on reorders below the head, and not on
// changes scoped to the excluded (active) thread.
export function selectQueueFlushHeadIds(
  state: ComposerQueueStoreState,
  excludeThreadKey: string | null,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [threadKey, queue] of Object.entries(state.queueByThreadKey)) {
    if (queue.length === 0) continue;
    if (threadKey === excludeThreadKey) continue;
    const head = queue[0];
    if (!head) continue;
    result[threadKey] = head.id;
  }
  return result;
}

const EMPTY_QUEUE: ReadonlyArray<QueuedMessageEntry> = Object.freeze([]);

export function newQueuedMessageId(): string {
  return `queued-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
