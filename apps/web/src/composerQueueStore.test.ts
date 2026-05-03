import { afterEach, describe, expect, it } from "vitest";
import { useComposerQueueStore, newQueuedMessageId } from "./composerQueueStore";

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
    useComposerQueueStore.setState({ queueByThreadKey: {} });
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

  it("takeNext pops the head and returns it", () => {
    const first = makeEntry("first");
    const second = makeEntry("second");
    const { enqueue, takeNext } = useComposerQueueStore.getState();
    enqueue(THREAD_A, first);
    enqueue(THREAD_A, second);
    expect(takeNext(THREAD_A)?.id).toBe(first.id);
    const queue = useComposerQueueStore.getState().queueByThreadKey[THREAD_A];
    expect(queue?.map((entry) => entry.id)).toEqual([second.id]);
  });

  it("takeNext returns null and is a no-op for empty queues", () => {
    expect(useComposerQueueStore.getState().takeNext(THREAD_A)).toBeNull();
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
