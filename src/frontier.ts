import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, PruneFrontier } from "./types.js";
import { CUSTOM_TYPE_FRONTIER } from "./types.js";

/**
 * Tracks the most recent completed prune-attempt boundary.
 *
 * The frontier advances when a prune attempt finishes, regardless of whether it
 * produced a persisted summary or was skipped because the summary was larger
 * than the raw tool outputs. It does not advance on operational failures.
 */
export class PruneFrontierTracker {
  private frontier: PruneFrontier | null = null;

  reset(): void {
    this.frontier = null;
  }

  get(): PruneFrontier | null {
    return this.frontier ? { ...this.frontier } : null;
  }

  fromJSON(data: PruneFrontier): void {
    if (!data?.lastAttemptedToolCallId) return;
    this.frontier = {
      lastAttemptedToolCallId: data.lastAttemptedToolCallId,
      lastAttemptedToolName: data.lastAttemptedToolName ?? "unknown",
      lastAttemptedTurnIndex: data.lastAttemptedTurnIndex ?? 0,
      lastAttemptedTimestamp: data.lastAttemptedTimestamp ?? 0,
      attemptedBatchCount: data.attemptedBatchCount ?? 0,
      attemptedToolCallCount: data.attemptedToolCallCount ?? 0,
      rawCharCount: data.rawCharCount ?? 0,
      summaryCharCount: data.summaryCharCount ?? 0,
      outcome: data.outcome ?? "summarized",
    };
  }

  reconstructFromSession(ctx: ExtensionContext): void {
    this.reset();
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === CUSTOM_TYPE_FRONTIER
      ) {
        const data = (entry as any).data as PruneFrontier;
        if (data) {
          this.fromJSON(data);
        }
      }
    }
  }

  advance(frontier: PruneFrontier): void {
    this.frontier = { ...frontier };
  }

  persist(pi: ExtensionAPI): void {
    if (!this.frontier) return;
    pi.appendEntry(CUSTOM_TYPE_FRONTIER, this.frontier);
  }
}

/**
 * Remove the part of a captured batch that the frontier (and the indexer) say has
 * already been handled.
 *
 * Extracted from the extension entry point so the frontier semantics can be
 * exercised without a live agent session. `batch.turnIndex` must be the
 * session-global assistant-message index produced by `resolveSessionTurnIndex()`
 * or `captureUnindexedBatchesFromSession()`; both use the same numbering.
 */
export function trimBatchToPendingRange(
  batch: CapturedBatch,
  frontier: PruneFrontier | null,
  indexer: { isSummarized(id: string): boolean }
): CapturedBatch | null {
  // The indexer tells us what was successfully summarized earlier.
  const toolCalls = batch.toolCalls.filter((tc) => !indexer.isSummarized(tc.toolCallId));
  if (toolCalls.length === 0) return null;

  if (!frontier) return { ...batch, toolCalls };

  // Strictly earlier turns are already behind the frontier. With normalized
  // session-global indices this no longer misclassifies turns of a new prompt.
  if (batch.turnIndex < frontier.lastAttemptedTurnIndex) return null;
  if (batch.turnIndex > frontier.lastAttemptedTurnIndex) return { ...batch, toolCalls };

  // Same turn: the frontier tells us where the previous attempt stopped, so keep
  // the tool calls that came after it instead of dropping the whole batch.
  const originalIndex = toolCalls.findIndex((tc) => tc.toolCallId === frontier.lastAttemptedToolCallId);
  if (originalIndex < 0) return { ...batch, toolCalls };

  const remaining = toolCalls.slice(originalIndex + 1);
  if (remaining.length === 0) return null;
  return { ...batch, toolCalls: remaining };
}
