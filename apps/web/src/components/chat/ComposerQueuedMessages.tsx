import { memo, useCallback } from "react";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ImageIcon,
  Loader2Icon,
  PencilIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import {
  COMPOSER_QUEUE_MAX_FAILURE_COUNT,
  useComposerQueueStore,
  useInFlightEntryForThread,
  useQueuedMessagesForThread,
  type QueuedMessageEntry,
} from "~/composerQueueStore";

interface ComposerQueuedMessagesProps {
  threadKey: string;
  className?: string;
  onEditEntry?: (entry: QueuedMessageEntry) => void;
}

export const ComposerQueuedMessages = memo(function ComposerQueuedMessages({
  threadKey,
  className,
  onEditEntry,
}: ComposerQueuedMessagesProps) {
  const queue = useQueuedMessagesForThread(threadKey);
  const inFlightEntry = useInFlightEntryForThread(threadKey);
  const removeEntry = useComposerQueueStore((store) => store.removeEntry);
  const clearForThread = useComposerQueueStore((store) => store.clearForThread);
  const reorder = useComposerQueueStore((store) => store.reorder);

  // Stable per-row handlers: row props don't churn just because the parent
  // re-renders, so QueuedMessageRow's memo actually buys re-render skipping.
  const handleRemoveById = useCallback(
    (entryId: string) => removeEntry(threadKey, entryId),
    [removeEntry, threadKey],
  );
  const handleMoveByIndex = useCallback(
    (fromIndex: number, delta: number) => reorder(threadKey, fromIndex, fromIndex + delta),
    [reorder, threadKey],
  );
  const handleClearAll = useCallback(() => {
    clearForThread(threadKey);
  }, [clearForThread, threadKey]);

  const totalCount = queue.length + (inFlightEntry ? 1 : 0);
  if (totalCount === 0) {
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
        <span>Queued ({totalCount})</span>
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
        {inFlightEntry && <InFlightMessageRow entry={inFlightEntry} />}
        {queue.map((entry, index) => (
          <QueuedMessageRow
            key={entry.id}
            entry={entry}
            position={index + 1}
            isFirst={index === 0}
            isLast={index === queue.length - 1}
            onRemoveById={handleRemoveById}
            onMoveByIndex={handleMoveByIndex}
            {...(onEditEntry ? { onEditEntry } : {})}
          />
        ))}
      </ul>
    </div>
  );
});

function getQueuedEntryPreview(entry: QueuedMessageEntry): {
  text: string;
  isPlaceholder: boolean;
} {
  if (entry.text.length > 0) return { text: entry.text, isPlaceholder: false };
  const imageCount = entry.images?.length ?? 0;
  if (imageCount > 0) {
    return {
      text: `${imageCount} image${imageCount === 1 ? "" : "s"}`,
      isPlaceholder: true,
    };
  }
  const contextCount = entry.terminalContexts?.length ?? 0;
  if (contextCount > 0) {
    return {
      text: `${contextCount} terminal context${contextCount === 1 ? "" : "s"}`,
      isPlaceholder: true,
    };
  }
  return { text: "Empty message", isPlaceholder: true };
}

const InFlightMessageRow = memo(function InFlightMessageRow({
  entry,
}: {
  entry: QueuedMessageEntry;
}) {
  const preview = getQueuedEntryPreview(entry);
  return (
    <li
      className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5"
      data-testid="composer-queued-message-in-flight"
    >
      <Loader2Icon className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          preview.isPlaceholder && "italic text-muted-foreground",
        )}
        title={preview.text}
      >
        {preview.text}
      </span>
      <span className="text-[10px] uppercase tracking-[0.18em] text-primary/80">Sending</span>
    </li>
  );
});

interface QueuedMessageRowProps {
  entry: QueuedMessageEntry;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  onRemoveById: (id: string) => void;
  onMoveByIndex: (fromIndex: number, delta: number) => void;
  onEditEntry?: (entry: QueuedMessageEntry) => void;
}

const QueuedMessageRow = memo(function QueuedMessageRow({
  entry,
  position,
  isFirst,
  isLast,
  onRemoveById,
  onMoveByIndex,
  onEditEntry,
}: QueuedMessageRowProps) {
  const preview = getQueuedEntryPreview(entry);
  const imageCount = entry.images?.length ?? 0;
  const contextCount = entry.terminalContexts?.length ?? 0;

  const fromIndex = position - 1;
  const handleMoveUp = useCallback(() => {
    onMoveByIndex(fromIndex, -1);
  }, [onMoveByIndex, fromIndex]);
  const handleMoveDown = useCallback(() => {
    onMoveByIndex(fromIndex, 1);
  }, [onMoveByIndex, fromIndex]);
  const handleRemove = useCallback(() => {
    onRemoveById(entry.id);
  }, [onRemoveById, entry.id]);
  const handleEdit = useCallback(() => {
    onEditEntry?.(entry);
  }, [onEditEntry, entry]);

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLLIElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.key === "ArrowUp" && (event.metaKey || event.altKey) && !isFirst) {
        event.preventDefault();
        handleMoveUp();
        return;
      }
      if (event.key === "ArrowDown" && (event.metaKey || event.altKey) && !isLast) {
        event.preventDefault();
        handleMoveDown();
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey) {
        event.preventDefault();
        handleRemove();
        return;
      }
      if (event.key === "Enter" && onEditEntry) {
        event.preventDefault();
        handleEdit();
      }
    },
    [handleEdit, handleMoveDown, handleMoveUp, handleRemove, isFirst, isLast, onEditEntry],
  );

  const failureCount = entry.failureCount ?? 0;
  const hasFailure = failureCount > 0;

  return (
    <li
      className={cn(
        "group flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring",
        hasFailure ? "border-amber-500/60" : "border-border/70",
      )}
      data-testid="composer-queued-message-entry"
      tabIndex={0}
      onKeyDown={handleRowKeyDown}
    >
      <span className="text-[10px] font-semibold tabular-nums text-muted-foreground/70">
        {position}
      </span>
      {hasFailure && (
        <span
          className="flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
          title={`Last ${failureCount} attempt${failureCount === 1 ? "" : "s"} failed; will be dropped after ${COMPOSER_QUEUE_MAX_FAILURE_COUNT} consecutive failures`}
        >
          <AlertTriangleIcon className="h-3 w-3" aria-hidden="true" />
          retry {failureCount}/{COMPOSER_QUEUE_MAX_FAILURE_COUNT}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          preview.isPlaceholder && "italic text-muted-foreground",
        )}
        title={preview.text}
      >
        {preview.text}
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
      <div className="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={handleMoveUp}
          disabled={isFirst}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          aria-label="Move up"
        >
          <ArrowUpIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleMoveDown}
          disabled={isLast}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          aria-label="Move down"
        >
          <ArrowDownIcon className="h-3.5 w-3.5" />
        </button>
        {onEditEntry && (
          <button
            type="button"
            onClick={handleEdit}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Edit queued message"
            title="Edit — restores to the composer and removes from the queue"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={handleRemove}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Remove queued message"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
});
