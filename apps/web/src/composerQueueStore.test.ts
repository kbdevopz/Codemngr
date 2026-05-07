import { afterEach, describe, expect, it } from "vitest";
import {
  COMPOSER_QUEUE_MAX_ENTRIES_PER_THREAD,
  COMPOSER_QUEUE_MAX_ENTRY_BYTES,
  COMPOSER_QUEUE_MAX_FAILURE_COUNT,
  newQueuedMessageId,
  useComposerQueueStore,
} from "./composerQueueStore";

const THREAD_A = "environment-local:thread-a";
const THREAD_B = "environment-local:thread-b";

function makeEntry(text: string) {
  return {
    id: newQueuedMessageId(),
    text,
    createdAt: "2026-05-03T14:00:00.000Z",
  };
}

describe("composerQueueStore", () => {
  afterEach(() => {
    useComposerQueueStore.setState({ queueByThreadKey: {}, inFlightByThreadKey: {} });
  });

  it("appends entries in submission order per thread", () => {
    const { enqueue } = useComposerQueueStore.getState();
    enqueue(THREAD_A, makeEntry("first"));
    enqueue(THREAD_A, makeEntry("second"));
    const queue = useComposerQueueStore.getState().queueByThreadKey[THREAD_A];
    expect(queue?.map((entry) => entry.text)).toEqual(["first", "second"]);
  });

  it("isolates queues per thread", () => {
    const { enqueue } = useComposerQueueStore.getState();
    enqueue(THREAD_A, makeEntry("a-only"));
    enqueue(THREAD_B, makeEntry("b-only"));
    const state = useComposerQueueStore.getState();
    expect(state.queueByThreadKey[THREAD_A]?.[0]?.text).toBe("a-only");
    expect(state.queueByThreadKey[THREAD_B]?.[0]?.text).toBe("b-only");
  });

  it("removeEntry drops the matching id and clears the thread key when empty", () => {
    const entry = makeEntry("to-remove");
    const { enqueue, removeEntry } = useComposerQueueStore.getState();
    enqueue(THREAD_A, entry);
    removeEntry(THREAD_A, entry.id);
    expect(useComposerQueueStore.getState().queueByThreadKey).not.toHaveProperty(THREAD_A);
  });

  it("removeEntry leaves remaining entries intact", () => {
    const keep = makeEntry("keep");
    const drop = makeEntry("drop");
    const { enqueue, removeEntry } = useComposerQueueStore.getState();
    enqueue(THREAD_A, keep);
    enqueue(THREAD_A, drop);
    removeEntry(THREAD_A, drop.id);
    const queue = useComposerQueueStore.getState().queueByThreadKey[THREAD_A];
    expect(queue?.map((entry) => entry.id)).toEqual([keep.id]);
  });

  it("beginInFlight moves the head into the in-flight slot", () => {
    const first = makeEntry("first");
    const second = makeEntry("second");
    const { enqueue, beginInFlight } = useComposerQueueStore.getState();
    enqueue(THREAD_A, first);
    enqueue(THREAD_A, second);
    expect(beginInFlight(THREAD_A)?.id).toBe(first.id);
    const state = useComposerQueueStore.getState();
    expect(state.queueByThreadKey[THREAD_A]?.map((entry) => entry.id)).toEqual([second.id]);
    expect(state.inFlightByThreadKey[THREAD_A]?.id).toBe(first.id);
  });

  it("beginInFlight returns null when the slot is already occupied", () => {
    const first = makeEntry("first");
    const second = makeEntry("second");
    const { enqueue, beginInFlight } = useComposerQueueStore.getState();
    enqueue(THREAD_A, first);
    enqueue(THREAD_A, second);
    expect(beginInFlight(THREAD_A)?.id).toBe(first.id);
    expect(beginInFlight(THREAD_A)).toBeNull();
  });

  it("beginInFlight returns null and is a no-op for empty queues", () => {
    expect(useComposerQueueStore.getState().beginInFlight(THREAD_A)).toBeNull();
  });

  it("completeInFlight on success drops the in-flight entry", () => {
    const entry = makeEntry("only");
    const { enqueue, beginInFlight, completeInFlight } = useComposerQueueStore.getState();
    enqueue(THREAD_A, entry);
    beginInFlight(THREAD_A);
    const result = completeInFlight(THREAD_A, true);
    expect(result.droppedAfterRetries).toBeNull();
    const state = useComposerQueueStore.getState();
    expect(state.inFlightByThreadKey[THREAD_A]).toBeUndefined();
    expect(state.queueByThreadKey[THREAD_A]).toBeUndefined();
  });

  it("completeInFlight on failure prepends the entry back to the queue with failureCount", () => {
    const head = makeEntry("head");
    const tail = makeEntry("tail");
    const { enqueue, beginInFlight, completeInFlight } = useComposerQueueStore.getState();
    enqueue(THREAD_A, head);
    enqueue(THREAD_A, tail);
    beginInFlight(THREAD_A);
    const result = completeInFlight(THREAD_A, false);
    expect(result.droppedAfterRetries).toBeNull();
    const state = useComposerQueueStore.getState();
    expect(state.inFlightByThreadKey[THREAD_A]).toBeUndefined();
    expect(state.queueByThreadKey[THREAD_A]?.map((entry) => entry.id)).toEqual([head.id, tail.id]);
    expect(state.queueByThreadKey[THREAD_A]?.[0]?.failureCount).toBe(1);
  });

  it("completeInFlight drops the entry after MAX_FAILURE_COUNT retries", () => {
    const entry = makeEntry("flaky");
    const { enqueue, beginInFlight, completeInFlight } = useComposerQueueStore.getState();
    enqueue(THREAD_A, entry);
    let lastResult: ReturnType<typeof completeInFlight> | null = null;
    for (let attempt = 0; attempt < COMPOSER_QUEUE_MAX_FAILURE_COUNT + 1; attempt += 1) {
      const taken = beginInFlight(THREAD_A);
      expect(taken).not.toBeNull();
      lastResult = completeInFlight(THREAD_A, false);
    }
    expect(lastResult?.droppedAfterRetries?.id).toBe(entry.id);
    const state = useComposerQueueStore.getState();
    expect(state.queueByThreadKey[THREAD_A]).toBeUndefined();
    expect(state.inFlightByThreadKey[THREAD_A]).toBeUndefined();
  });

  it("clearForThread removes the thread's queue but preserves others", () => {
    const { enqueue, clearForThread } = useComposerQueueStore.getState();
    enqueue(THREAD_A, makeEntry("a"));
    enqueue(THREAD_B, makeEntry("b"));
    clearForThread(THREAD_A);
    const state = useComposerQueueStore.getState();
    expect(state.queueByThreadKey).not.toHaveProperty(THREAD_A);
    expect(state.queueByThreadKey[THREAD_B]?.length).toBe(1);
  });

  it("newQueuedMessageId returns unique values", () => {
    const ids = new Set([newQueuedMessageId(), newQueuedMessageId(), newQueuedMessageId()]);
    expect(ids.size).toBe(3);
  });

  it("rejects enqueue when the per-thread cap is reached", () => {
    const { enqueue } = useComposerQueueStore.getState();
    for (let index = 0; index < COMPOSER_QUEUE_MAX_ENTRIES_PER_THREAD; index += 1) {
      const result = enqueue(THREAD_A, makeEntry(`message ${index}`));
      expect(result.ok).toBe(true);
    }
    const overflow = enqueue(THREAD_A, makeEntry("over the limit"));
    expect(overflow).toEqual({ ok: false, reason: "queue-full" });
    expect(useComposerQueueStore.getState().queueByThreadKey[THREAD_A]?.length).toBe(
      COMPOSER_QUEUE_MAX_ENTRIES_PER_THREAD,
    );
  });

  it("rejects entries that would exceed the per-entry size cap", () => {
    const { enqueue } = useComposerQueueStore.getState();
    const oversizedDataUrl = `data:image/png;base64,${"A".repeat(COMPOSER_QUEUE_MAX_ENTRY_BYTES + 1)}`;
    const oversized = enqueue(THREAD_A, {
      ...makeEntry("with huge image"),
      images: [
        {
          id: "image-huge",
          name: "huge.png",
          mimeType: "image/png",
          sizeBytes: oversizedDataUrl.length,
          dataUrl: oversizedDataUrl,
        },
      ],
    });
    expect(oversized).toEqual({ ok: false, reason: "entry-too-large" });
    expect(useComposerQueueStore.getState().queueByThreadKey[THREAD_A]).toBeUndefined();
  });

  it("reorder swaps positions in place", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const { enqueue, reorder } = useComposerQueueStore.getState();
    enqueue(THREAD_A, a);
    enqueue(THREAD_A, b);
    enqueue(THREAD_A, c);
    reorder(THREAD_A, 0, 2);
    expect(
      useComposerQueueStore.getState().queueByThreadKey[THREAD_A]?.map((entry) => entry.text),
    ).toEqual(["b", "c", "a"]);
  });

  it("reorder is a no-op for invalid indices", () => {
    const { enqueue, reorder } = useComposerQueueStore.getState();
    enqueue(THREAD_A, makeEntry("only"));
    reorder(THREAD_A, 0, 5);
    expect(useComposerQueueStore.getState().queueByThreadKey[THREAD_A]?.length).toBe(1);
    reorder(THREAD_A, -1, 0);
    expect(useComposerQueueStore.getState().queueByThreadKey[THREAD_A]?.length).toBe(1);
  });

  it("preserves images and terminal contexts captured at enqueue time", () => {
    const entry = {
      ...makeEntry("with attachments"),
      images: [
        {
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 100,
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
      terminalContexts: [
        {
          id: "context-1",
          threadId: "thread-1" as never,
          createdAt: "2026-05-03T14:00:00.000Z",
          terminalId: "term-1",
          terminalLabel: "zsh",
          lineStart: 0,
          lineEnd: 5,
          text: "$ ls\nfile.txt",
        },
      ],
    };
    const { enqueue } = useComposerQueueStore.getState();
    enqueue(THREAD_A, entry);
    const stored = useComposerQueueStore.getState().queueByThreadKey[THREAD_A]?.[0];
    expect(stored?.images?.[0]?.id).toBe("image-1");
    expect(stored?.terminalContexts?.[0]?.id).toBe("context-1");
  });
});
