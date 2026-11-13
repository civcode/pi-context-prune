import type { CapturedBatch, CapturedToolCall } from "./types.js";

/** A single provider attempt, distinct from an error that must not be retried. */
export type SplitAttempt<T> =
  | { kind: "success"; value: T }
  | { kind: "context-overflow" }
  | { kind: "failure" };

export interface SplitSegment<T> {
  batch: CapturedBatch;
  result: T | null;
}

/**
 * Recognize known context-limit rejections, not arbitrary HTTP 400 responses.
 * Provider adapters do not share a standard error code, so inspect structured
 * codes first and then familiar error messages. Unknown errors are not split.
 */
export function isContextOverflow(error: unknown): boolean {
  const value = error && typeof error === "object" ? error as Record<string, any> : {};
  const nested = value.error && typeof value.error === "object" ? value.error : {};
  const codes = [value.code, value.type, nested.code, nested.type]
    .filter((code) => typeof code === "string");
  if (codes.some((code) => /^(?:context_length_exceeded|context_window_exceeded|prompt_too_long|input_too_long)$/i.test(code))) {
    return true;
  }

  const message = [
    typeof error === "string" ? error : "",
    value.message,
    value.errorMessage,
    typeof value.error === "string" ? value.error : "",
    nested.message,
  ].filter((part) => typeof part === "string").join(" ");

  return [
    /\bcontext[_ -]length[_ -]exceeded\b/i,
    /\bcontext[_ -]window[_ -](?:exceeded|overflow)\b/i,
    /\bmaximum context length\b/i,
    /\b(?:exceeds?|exceeded|too (?:long|large)|larger than)\b.{0,120}\bcontext (?:window|length|limit)\b/i,
    /\bcontext (?:window|length|limit)\b.{0,120}\b(?:exceeds?|exceeded|too (?:long|large)|maximum|limit|over)\b/i,
    /\b(?:prompt|input) (?:is )?too long\b/i,
    /\b(?:prompt|input|request)\b.{0,120}\b(?:token|tokens)\b.{0,120}\b(?:exceeds?|exceeded|limit)\b/i,
    /\b(?:exceeds?|exceeded)\b.{0,120}\b(?:input tokens|maximum number of tokens)\b/i,
  ].some((pattern) => pattern.test(message));
}

/**
 * Preserve original order and the last tool call's *session-global* turn
 * position. Merged agent-message batches may span hundreds of assistant turns;
 * reusing the merged batch's final turn for a partial slice would cause the
 * frontier to skip unsummarized earlier turns after a restart.
 */
export function sliceBatch(batch: CapturedBatch, toolCalls: CapturedToolCall[]): CapturedBatch {
  const last = toolCalls[toolCalls.length - 1];
  return {
    ...batch,
    toolCalls,
    turnIndex: last.sourceTurnIndex ?? batch.turnIndex,
    timestamp: last.sourceTimestamp ?? batch.timestamp,
    // The merged assistant prose cannot be split safely by tool-call index.
    // Avoid duplicating it into both halves or leaking later prose into earlier ones.
    assistantText: "",
  };
}

/**
 * The original full-batch request has ALREADY failed with context overflow.
 * Split into contiguous halves and retry left first. No token estimator, fixed
 * size, or model-specific configuration is used.
 *
 * A non-overflow failure stops further calls, returning the unattempted right
 * half as pending; the caller persists only the successful chronological prefix.
 */
export async function splitOverflowingBatch<T>(
  overflowingBatch: CapturedBatch,
  attempt: (batch: CapturedBatch) => Promise<SplitAttempt<T>>,
  options: {
    onSplit?: (batch: CapturedBatch) => void;
    onSingleCallOverflow?: (batch: CapturedBatch) => void;
  } = {},
): Promise<SplitSegment<T>[]> {
  async function split(batch: CapturedBatch): Promise<SplitSegment<T>[]> {
    if (batch.toolCalls.length <= 1) {
      options.onSingleCallOverflow?.(batch);
      return [{ batch, result: null }];
    }

    options.onSplit?.(batch);
    const midpoint = Math.ceil(batch.toolCalls.length / 2);
    const left = sliceBatch(batch, batch.toolCalls.slice(0, midpoint));
    const right = sliceBatch(batch, batch.toolCalls.slice(midpoint));

    const first = await resolve(left);
    // Do not attempt later tool calls after an unrecoverable earlier failure.
    // They must remain queued in their original relative order.
    if (first.some((segment) => segment.result === null)) {
      return [...first, { batch: right, result: null }];
    }
    return [...first, ...await resolve(right)];
  }

  async function resolve(batch: CapturedBatch): Promise<SplitSegment<T>[]> {
    const outcome = await attempt(batch);
    if (outcome.kind === "success") return [{ batch, result: outcome.value }];
    if (outcome.kind === "failure") return [{ batch, result: null }];
    return split(batch);
  }

  return split(overflowingBatch);
}
