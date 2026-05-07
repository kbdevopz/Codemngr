import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
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
}

export type EnqueueResult = { ok: true } | { ok: false; reason: "queue-full" | "entry-too-large" };

export interface ComposerQueueStoreState {
  queueByThreadKey: Record<string, ReadonlyArray<QueuedMessageEntry>>;
  enqueue: (threadKey: string, entry: QueuedMessageEntry) => EnqueueResult;
  removeEntry: (threadKey: string, entryId: string) => void;
  takeNext: (threadKey: string) => QueuedMessageEntry | null;
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
      takeNext: (threadKey) => {
        const existing = get().queueByThreadKey[threadKey];
        const head = existing?.[0] ?? null;
        if (!head) return null;
        set((state) => {
          const current = state.queueByThreadKey[threadKey];
          if (!current || current.length === 0) return state;
          const [, ...rest] = current;
          const { [threadKey]: _removed, ...others } = state.queueByThreadKey;
          if (rest.length === 0) {
            return { queueByThreadKey: others };
          }
          return { queueByThreadKey: { ...others, [threadKey]: rest } };
        });
        return head;
      },
      clearForThread: (threadKey) => {
        set((state) => {
          if (!state.queueByThreadKey[threadKey]) return state;
          const { [threadKey]: _removed, ...rest } = state.queueByThreadKey;
          return { queueByThreadKey: rest };
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
      partialize: (state) => ({ queueByThreadKey: state.queueByThreadKey }),
    },
  ),
);

export function useQueuedMessagesForThread(threadKey: string): ReadonlyArray<QueuedMessageEntry> {
  return useComposerQueueStore(
    useShallow((store) => store.queueByThreadKey[threadKey] ?? EMPTY_QUEUE),
  );
}

export function useQueueHeadIdForThread(threadKey: string): string | null {
  return useComposerQueueStore((store) => store.queueByThreadKey[threadKey]?.[0]?.id ?? null);
}

const EMPTY_QUEUE: ReadonlyArray<QueuedMessageEntry> = Object.freeze([]);

export function newQueuedMessageId(): string {
  return `queued-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
