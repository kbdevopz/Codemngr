import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { useComposerQueueStore } from "../../composerQueueStore";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";

const THREAD_KEY = "environment-local:thread-render";

describe("ComposerQueuedMessages", () => {
  afterEach(() => {
    useComposerQueueStore.setState({ queueByThreadKey: {}, inFlightByThreadKey: {} });
  });

  it("returns null when there is nothing queued", () => {
    const markup = renderToStaticMarkup(<ComposerQueuedMessages threadKey={THREAD_KEY} />);
    expect(markup).toBe("");
  });
});
