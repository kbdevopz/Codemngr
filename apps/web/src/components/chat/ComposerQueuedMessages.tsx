import { memo, useCallback } from "react";
import { ImageIcon, TerminalIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  useQueuedMessagesForThread,
  useComposerQueueStore,
  type QueuedMessageEntry,
} from "~/composerQueueStore";

interface ComposerQueuedMessagesProps {
  threadKey: string;
  className?: string;
}

export const ComposerQueuedMessages = memo(function ComposerQueuedMessages({
  threadKey,
  className,
}: ComposerQueuedMessagesProps) {
  const queue = useQueuedMessagesForThread(threadKey);
  const removeEntry = useComposerQueueStore((store) => store.removeEntry);
  const clearForThread = useComposerQueueStore((store) => store.clearForThread);

  const handleRemove = useCallback(
    (entryId: string) => () => {
      removeEntry(threadKey, entryId);
    },
    [removeEntry, threadKey],
  );

  const handleClearAll = useCallback(() => {
    clearForThread(threadKey);
  }, [clearForThread, threadKey]);

  if (queue.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-t-[18px] border-x border-t border-border/65 bg-muted/30 px-3 py-2 sm:px-4",
        className,
      )}
      data-testid="composer-queued-messages"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        <span>Queued ({queue.length})</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
          — sent in order when the current turn ends
        </span>
        {queue.length > 1 && (
          <button
            type="button"
            onClick={handleClearAll}
            className="rounded text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {queue.map((entry, index) => (
          <QueuedMessageRow
            key={entry.id}
            entry={entry}
            position={index + 1}
            onRemove={handleRemove(entry.id)}
          />
        ))}
      </ul>
    </div>
  );
});

interface QueuedMessageRowProps {
  entry: QueuedMessageEntry;
  position: number;
  onRemove: () => void;
}

const QueuedMessageRow = memo(function QueuedMessageRow({
  entry,
  position,
  onRemove,
}: QueuedMessageRowProps) {
  const imageCount = entry.images?.length ?? 0;
  const contextCount = entry.terminalContexts?.length ?? 0;
  const hasText = entry.text.length > 0;
  const previewText = hasText
    ? entry.text
    : imageCount > 0
      ? `${imageCount} image${imageCount === 1 ? "" : "s"}`
      : contextCount > 0
        ? `${contextCount} terminal context${contextCount === 1 ? "" : "s"}`
        : "Empty message";

  return (
    <li
      className="group flex items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 py-1.5"
      data-testid="composer-queued-message-entry"
    >
      <span className="text-[10px] font-semibold tabular-nums text-muted-foreground/70">
        {position}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          !hasText && "italic text-muted-foreground",
        )}
        title={previewText}
      >
        {previewText}
      </span>
      {imageCount > 0 && (
        <span
          className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
          title={`${imageCount} image${imageCount === 1 ? "" : "s"}`}
        >
          <ImageIcon className="h-3 w-3" aria-hidden="true" />
          {imageCount}
        </span>
      )}
      {contextCount > 0 && (
        <span
          className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
          title={`${contextCount} terminal context${contextCount === 1 ? "" : "s"}`}
        >
          <TerminalIcon className="h-3 w-3" aria-hidden="true" />
          {contextCount}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Remove queued message"
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </li>
  );
});
