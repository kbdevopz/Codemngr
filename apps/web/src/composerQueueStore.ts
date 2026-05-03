import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// MVP queue: text-only messages waiting to be sent while a turn is in
// progress. Attachments and terminal contexts are intentionally not
// queued yet — that requires factoring the dispatch path in ChatView's
// onSend into a snapshot-driven helper. Until then, attempting to queue
// a message with attachments falls back to the existing drop behavior
// at the call site, so this is purely additive.
//
// Persistence: in-memory only. Queues are session-scoped — closing the
// app drops them. The same model as VS Code's terminal scrollback or
// in-flight tool runs.

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

export const useComposerQueueStore = create<ComposerQueueStoreState>((set, get) => ({
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
}));

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
