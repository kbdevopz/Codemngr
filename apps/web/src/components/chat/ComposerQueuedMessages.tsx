import { memo, useCallback } from "react";
import { XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { useQueuedMessagesForThread, useComposerQueueStore } from "~/composerQueueStore";

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

  const handleRemove = useCallback(
    (entryId: string) => () => {
      removeEntry(threadKey, entryId);
    },
    [removeEntry, threadKey],
  );

  if (queue.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-b border-border/60 bg-muted/30 px-3 py-2 sm:px-5",
        className,
      )}
      data-testid="composer-queued-messages"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        <span>Queued ({queue.length})</span>
        <span className="text-muted-foreground/60">— sent in order when the current turn ends</span>
      </div>
      <ul className="flex flex-col gap-1">
        {queue.map((entry) => (
          <li
            key={entry.id}
            className="group flex items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 py-1.5"
            data-testid="composer-queued-message-entry"
          >
            <span className="min-w-0 flex-1 truncate text-sm" title={entry.text}>
              {entry.text}
            </span>
            <button
              type="button"
              onClick={handleRemove(entry.id)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Remove queued message"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});
