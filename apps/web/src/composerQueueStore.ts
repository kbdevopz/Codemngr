import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";

// Per-thread queue of messages waiting to be sent while a turn is in
// progress. Attachments and terminal contexts are intentionally not
// queued yet — that requires factoring the dispatch path in ChatView's
// onSend into a snapshot-driven helper. Until then, attempting to queue
// a message with attachments falls back to the existing drop behavior
// at the call site, so this is purely additive.
//
// Persistence: queues survive reload via localStorage with a debounced
// writer (300ms). On unload we flush so an in-flight write doesn't drop
// queued messages. Stale queues for deleted threads are not pruned
// automatically yet; callers can call clearForThread on thread.deleted.

export const COMPOSER_QUEUE_STORAGE_KEY = "codemngr:composer-queue:v1";
const COMPOSER_QUEUE_STORAGE_VERSION = 1;
const COMPOSER_QUEUE_PERSIST_DEBOUNCE_MS = 300;

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
}

export interface ComposerQueueStoreState {
  queueByThreadKey: Record<string, ReadonlyArray<QueuedMessageEntry>>;
  enqueue: (threadKey: string, entry: QueuedMessageEntry) => void;
  removeEntry: (threadKey: string, entryId: string) => void;
  takeNext: (threadKey: string) => QueuedMessageEntry | null;
  clearForThread: (threadKey: string) => void;
}

export const useComposerQueueStore = create<ComposerQueueStoreState>()(
  persist(
    (set, get) => ({
      queueByThreadKey: {},
      enqueue: (threadKey, entry) => {
        set((state) => {
          const existing = state.queueByThreadKey[threadKey] ?? [];
          return {
            queueByThreadKey: {
              ...state.queueByThreadKey,
              [threadKey]: [...existing, entry],
            },
          };
        });
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
