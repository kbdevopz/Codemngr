import {
  DEFAULT_MODEL,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { truncate } from "@t3tools/shared/String";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import { newCommandId, newMessageId } from "./utils";
import { readEnvironmentApi } from "../environmentApi";
import { useStore, selectProjectByRef, selectThreadByRef } from "../store";
import { type ComposerImageAttachment, type DraftThreadEnvMode } from "../composerDraftStore";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from "./terminalContext";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { buildExpiredTerminalContextToastCopy } from "../components/ChatView.logic";
import { getProviderModelCapabilities } from "../providerModels";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Failed to read file")),
    );
    reader.addEventListener("load", () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
      } else {
        reject(new Error("Unexpected FileReader result"));
      }
    });
    reader.readAsDataURL(file);
  });
}

function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}

export interface DispatchPayload {
  threadRef: ScopedThreadRef;
  text: string;
  trimmed: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  expiredTerminalContextCount: number;
  selectedModelSelection: ModelSelection;
  selectedProvider: ProviderDriverKind;
  selectedModel: string;
  selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  selectedPromptEffort: string | null;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  /** True only for the first send on a local draft thread (creates the server thread). */
  isLocalDraftThread?: boolean;
  /** Composer's current envMode — used to decide worktree creation on first message. */
  sendEnvMode?: DraftThreadEnvMode;
  /** Branch chosen for new worktrees. */
  activeThreadBranch?: string | null;
}

export type DispatchOptimisticAttachment = {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
};

export interface DispatchHandlers {
  /**
   * Called after the message id and outgoing text are computed but before
   * any API call. Use this to add an optimistic message to the timeline
   * and scroll to the bottom. Background dispatchers can leave this empty.
   */
  onBeforeDispatch?: (info: {
    messageIdForSend: MessageId;
    messageCreatedAt: string;
    outgoingMessageText: string;
    optimisticAttachments: DispatchOptimisticAttachment[];
  }) => void | Promise<void>;
  /**
   * Called when the dispatch fails. setThreadError has already been called
   * for the target thread. Use this to remove the optimistic message and
   * restore composer state for retry. Background dispatchers can re-queue
   * here, or leave the user to handle it.
   */
  onDispatchError?: (info: {
    messageIdForSend: MessageId;
    error: unknown;
    payload: DispatchPayload;
  }) => void | Promise<void>;
  /** Active-thread only: called once dispatch starts so the local-dispatch UI snapshot can prepare. */
  beginLocalDispatch?: (opts: { preparingWorktree: boolean }) => void;
  /** Active-thread only: called on dispatch failure so the local-dispatch snapshot resets. */
  resetLocalDispatch?: () => void;
  /** Active-thread only: marks send-in-flight to dedupe rapid resubmits. */
  markSendInFlight?: (inFlight: boolean) => void;
}

export type DispatchResult = { ok: boolean };

export async function dispatchUserMessage(
  payload: DispatchPayload,
  handlers: DispatchHandlers = {},
): Promise<DispatchResult> {
  const state = useStore.getState();
  const thread = selectThreadByRef(state, payload.threadRef);
  if (!thread) return { ok: false };
  const project = selectProjectByRef(
    state,
    scopeProjectRef(payload.threadRef.environmentId, thread.projectId),
  );
  if (!project) return { ok: false };
  const api = readEnvironmentApi(payload.threadRef.environmentId);
  if (!api) return { ok: false };

  const setThreadError = state.setError;
  const isLocalDraftThread = payload.isLocalDraftThread ?? false;
  const isServerThread = !isLocalDraftThread;
  const isFirstMessage = !isServerThread || thread.messages.length === 0;
  const baseBranchForWorktree =
    isFirstMessage && payload.sendEnvMode === "worktree" && !thread.worktreePath
      ? (payload.activeThreadBranch ?? null)
      : null;
  const shouldCreateWorktree =
    isFirstMessage && payload.sendEnvMode === "worktree" && !thread.worktreePath;
  if (shouldCreateWorktree && !payload.activeThreadBranch) {
    setThreadError(thread.id, "Select a base branch before sending in New worktree mode.");
    return { ok: false };
  }

  handlers.markSendInFlight?.(true);
  handlers.beginLocalDispatch?.({ preparingWorktree: Boolean(baseBranchForWorktree) });

  const messageIdForSend = newMessageId();
  const messageCreatedAt = new Date().toISOString();
  const messageTextForSend = appendTerminalContextsToPrompt(payload.text, [
    ...payload.terminalContexts,
  ]);
  const outgoingMessageText = formatOutgoingPrompt({
    provider: payload.selectedProvider,
    model: payload.selectedModel,
    models: payload.selectedProviderModels,
    effort: payload.selectedPromptEffort,
    text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
  });
  const turnAttachmentsPromise = Promise.all(
    payload.images.map(async (image) => ({
      type: "image" as const,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await readFileAsDataUrl(image.file),
    })),
  );
  const optimisticAttachments: DispatchOptimisticAttachment[] = payload.images.map((image) => ({
    type: "image" as const,
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    previewUrl: image.previewUrl,
  }));

  setThreadError(thread.id, null);

  if (handlers.onBeforeDispatch) {
    await handlers.onBeforeDispatch({
      messageIdForSend,
      messageCreatedAt,
      outgoingMessageText,
      optimisticAttachments,
    });
  }

  if (payload.expiredTerminalContextCount > 0) {
    const toastCopy = buildExpiredTerminalContextToastCopy(
      payload.expiredTerminalContextCount,
      "omitted",
    );
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      }),
    );
  }

  let turnStartSucceeded = false;
  try {
    const firstImageName = payload.images[0]?.name ?? null;
    let titleSeed = payload.trimmed;
    if (!titleSeed) {
      if (firstImageName) {
        titleSeed = `Image: ${firstImageName}`;
      } else if (payload.terminalContexts.length > 0) {
        titleSeed = formatTerminalContextLabel(payload.terminalContexts[0]!);
      } else {
        titleSeed = "New thread";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      payload.selectedModelSelection.instanceId,
      payload.selectedModel || project.defaultModelSelection?.model || DEFAULT_MODEL,
      payload.selectedModelSelection.options,
    );

    if (isFirstMessage && isServerThread) {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: thread.id,
        title,
      });
    }

    if (isServerThread) {
      await persistThreadSettingsForTurn({
        thread,
        environmentId: payload.threadRef.environmentId,
        threadId: thread.id,
        createdAt: messageCreatedAt,
        ...(payload.selectedModel ? { modelSelection: payload.selectedModelSelection } : {}),
        runtimeMode: payload.runtimeMode,
        interactionMode: payload.interactionMode,
      });
    }

    const turnAttachments = await turnAttachmentsPromise;
    const bootstrap =
      isLocalDraftThread || baseBranchForWorktree
        ? {
            ...(isLocalDraftThread
              ? {
                  createThread: {
                    projectId: project.id,
                    title,
                    modelSelection: threadCreateModelSelection,
                    runtimeMode: payload.runtimeMode,
                    interactionMode: payload.interactionMode,
                    branch: payload.activeThreadBranch ?? null,
                    worktreePath: thread.worktreePath,
                    createdAt: thread.createdAt,
                  },
                }
              : {}),
            ...(baseBranchForWorktree
              ? {
                  prepareWorktree: {
                    projectCwd: project.cwd,
                    baseBranch: baseBranchForWorktree,
                    branch: buildTemporaryWorktreeBranchName(),
                  },
                  runSetupScript: true,
                }
              : {}),
          }
        : undefined;
    handlers.beginLocalDispatch?.({ preparingWorktree: false });
    await api.orchestration.dispatchCommand({
      type: "thread.turn.start",
      commandId: newCommandId(),
      threadId: thread.id,
      message: {
        messageId: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        attachments: turnAttachments,
      },
      modelSelection: payload.selectedModelSelection,
      titleSeed: title,
      runtimeMode: payload.runtimeMode,
      interactionMode: payload.interactionMode,
      ...(bootstrap ? { bootstrap } : {}),
      createdAt: messageCreatedAt,
    });
    turnStartSucceeded = true;
  } catch (err) {
    setThreadError(thread.id, err instanceof Error ? err.message : "Failed to send message.");
    if (handlers.onDispatchError) {
      await handlers.onDispatchError({
        messageIdForSend,
        error: err,
        payload,
      });
    }
  }

  handlers.markSendInFlight?.(false);
  if (!turnStartSucceeded) {
    handlers.resetLocalDispatch?.();
  }
  return { ok: turnStartSucceeded };
}

interface PersistThreadSettingsInput {
  thread: NonNullable<ReturnType<typeof selectThreadByRef>>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  createdAt: string;
  modelSelection?: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

async function persistThreadSettingsForTurn(input: PersistThreadSettingsInput): Promise<void> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) return;
  const { thread } = input;
  if (
    input.modelSelection !== undefined &&
    (input.modelSelection.model !== thread.modelSelection.model ||
      input.modelSelection.instanceId !== thread.modelSelection.instanceId ||
      JSON.stringify(input.modelSelection.options ?? null) !==
        JSON.stringify(thread.modelSelection.options ?? null))
  ) {
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: input.threadId,
      modelSelection: input.modelSelection,
    });
  }
  if (input.runtimeMode !== thread.runtimeMode) {
    await api.orchestration.dispatchCommand({
      type: "thread.runtime-mode.set",
      commandId: newCommandId(),
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      createdAt: input.createdAt,
    });
  }
  if (input.interactionMode !== thread.interactionMode) {
    await api.orchestration.dispatchCommand({
      type: "thread.interaction-mode.set",
      commandId: newCommandId(),
      threadId: input.threadId,
      interactionMode: input.interactionMode,
      createdAt: input.createdAt,
    });
  }
}
