/**
 * Model-independent regression tests for recursive binary splitting.
 * Uses esbuild only to load the actual TypeScript modules and a mock provider;
 * never contacts an inference backend or invokes GitHub Actions.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temp = mkdtempSync(join(process.cwd(), "node_modules", ".pruner-recursive-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const shim = join(temp, "pi-ai-shim.mjs");
writeFileSync(shim, "export const normalizeContext = value => value;\n");
await build({
  entryPoints: ["src/recursive-split.ts", "src/batch-capture.ts", "src/frontier.ts", "src/summarizer.ts"],
  outdir: temp,
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { "@earendil-works/pi-ai": shim },
  external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
  outExtension: { ".js": ".mjs" },
});

const load = async (file) => import(pathToFileURL(join(temp, file + ".mjs")).href);
const { splitOverflowingBatch, sliceBatch, isContextOverflow } = await load("recursive-split");
const { captureBatch, captureUnindexedBatchesFromSession, groupBatchesByMode } = await load("batch-capture");
const { trimBatchToPendingRange } = await load("frontier");
const { summarizeBatch } = await load("summarizer");

const mkBatch = (n) => ({
  turnIndex: 1000,
  timestamp: 1000,
  assistantText: "Some future assistant prose",
  userTurnGroup: 1,
  toolCalls: Array.from({ length: n }, (_, i) => ({
    toolCallId: `tc-${i + 1}`,
    toolName: "read",
    args: {},
    resultText: "raw data",
    isError: false,
    sourceTurnIndex: i,
    sourceTimestamp: 100 + i,
  })),
});
const range = (batch) => batch.toolCalls.map((tc) => Number(tc.toolCallId.slice(3)));

test("recognizes cross-provider context-limit errors, but not generic HTTP errors", () => {
  for (const err of [
    new Error("request exceeds the context window: prompt (287562 tokens) leaves no room to answer in the context (262144)"),
    { code: "context_length_exceeded", message: "bad request" },
    { error: { code: "context_window_exceeded" } },
    new Error("maximum context length is 128000 tokens"),
    new Error("prompt is too long"),
    new Error("input token count exceeds the maximum number of tokens allowed"),
    new Error("context window overflow"),
  ]) assert.equal(isContextOverflow(err), true, String(err));
  for (const err of [
    new Error("HTTP 400 Bad Request"),
    { status: 400, message: "incorrect parameter" },
    new Error("429 rate limit exceeded"),
    new Error("invalid API key"),
    new Error("network timeout"),
    new Error("maximum output tokens exceeded"),
  ]) assert.equal(isContextOverflow(err), false, String(err));
});

test("417 calls split into ordered contiguous leaves without gaps or duplicates", async () => {
  const batch = mkBatch(417);
  const attempts = [];
  const result = await splitOverflowingBatch(batch, async (piece) => {
    attempts.push(range(piece));
    return piece.toolCalls.length > 105
      ? { kind: "context-overflow" }
      : { kind: "success", value: range(piece) };
  });
  assert.deepEqual(
    result.flatMap((segment) => segment.result),
    Array.from({ length: 417 }, (_, i) => i + 1),
  );
  assert.ok(result.every((segment) => segment.batch.turnIndex === segment.batch.toolCalls.at(-1).sourceTurnIndex));
  assert.ok(result.every((segment) => segment.batch.assistantText === ""));
  assert.deepEqual(range(result[0].batch), Array.from({ length: 105 }, (_, i) => i + 1));
  assert.equal(attempts[0].length, 209);
});

test("nested splits are attempted strictly left first", async () => {
  const attempts = [];
  const pieces = await splitOverflowingBatch(mkBatch(8), async (part) => {
    const s = range(part).join("-");
    attempts.push(s);
    return s === "1-2-3-4"
      ? { kind: "context-overflow" }
      : { kind: "success", value: s };
  });
  assert.deepEqual(attempts, ["1-2-3-4", "1-2", "3-4", "5-6-7-8"]);
  assert.deepEqual(pieces.map((part) => part.result), ["1-2", "3-4", "5-6-7-8"]);
});

test("a single oversized call stops without another model request", async () => {
  let calls = 0, single = 0;
  const pieces = await splitOverflowingBatch(mkBatch(1), async () => {
    calls++;
    return { kind: "context-overflow" };
  }, { onSingleCallOverflow: () => single++ });
  assert.equal(calls, 0); // The full original single-call attempt already failed.
  assert.equal(single, 1);
  assert.equal(pieces[0].result, null);
});

test("non-context failure retains unattempted suffix in order", async () => {
  const attempts = [];
  const pieces = await splitOverflowingBatch(mkBatch(8), async (part) => {
    const s = range(part).join("-");
    attempts.push(s);
    if (s === "3-4") return { kind: "failure" };
    if (s === "1-2-3-4") return { kind: "context-overflow" };
    return { kind: "success", value: s };
  });
  assert.deepEqual(attempts, ["1-2-3-4", "1-2", "3-4"]);
  assert.deepEqual(pieces.map((part) => part.result), ["1-2", null, null]);
  assert.deepEqual(pieces.map((part) => range(part.batch)), [[1, 2], [3, 4], [5, 6, 7, 8]]);
  assert.equal(pieces[0].batch.turnIndex, 1);
});

test("splitting preserves source turn and timestamp without mutating parent", () => {
  const parent = mkBatch(4);
  const left = sliceBatch(parent, parent.toolCalls.slice(0, 2));
  assert.equal(parent.turnIndex, 1000);
  assert.equal(parent.assistantText, "Some future assistant prose");
  assert.equal(left.turnIndex, 1);
  assert.equal(left.timestamp, 101);
  assert.equal(left.userTurnGroup, 1);
});

test("real scan/group/split preserves a partial chronological frontier", () => {
  const branch = [{ type: "message", message: { role: "user", content: [] } }];
  for (let i = 0; i < 3; i++) {
    const ids = [2 * i + 1, 2 * i + 2];
    branch.push({
      type: "message", timestamp: new Date(1000 + i).toISOString(),
      message: {
        role: "assistant",
        content: ids.map((n) => ({ type: "toolCall", id: `tc-${n}`, name: "read", input: {} })),
      },
    });
    for (const n of ids) {
      branch.push({ type: "message", message: {
        role: "toolResult", toolCallId: `tc-${n}`,
        content: [{ type: "text", text: "some raw output" }], isError: false,
      } });
    }
  }
  const indexer = { isSummarized: () => false };
  const perTurn = captureUnindexedBatchesFromSession(branch, indexer);
  assert.deepEqual(perTurn.map((b) => b.turnIndex), [0, 1, 2]);
  const grouped = groupBatchesByMode(perTurn, "agent-message");
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].toolCalls.length, 6);
  const first = sliceBatch(grouped[0], grouped[0].toolCalls.slice(0, 3));
  assert.equal(first.turnIndex, 1);
  const frontier = { lastAttemptedTurnIndex: first.turnIndex, lastAttemptedToolCallId: "tc-3" };
  const indexed = new Set(["tc-1", "tc-2", "tc-3"]);
  const trimmed = perTurn
    .map((b) => trimBatchToPendingRange(b, frontier, { isSummarized: (id) => indexed.has(id) }))
    .filter(Boolean);
  assert.deepEqual(trimmed.flatMap((b) => b.toolCalls.map((tc) => tc.toolCallId)), ["tc-4", "tc-5", "tc-6"]);
});

test("provider stopReason error triggers silent overflow callback", async () => {
  const notifications = [];
  let requests = 0, overflow = "";
  const ctx = {
    model: { provider: "mock", id: "mock" },
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
      getProvider: () => ({ stream: () => {
        requests++;
        return {
          async *[Symbol.asyncIterator]() {},
          result: async () => ({
            role: "assistant", content: [], stopReason: "error",
            errorMessage: "request exceeds the context window",
            usage: { input: 0, output: 0 },
          }),
        };
      } }),
    },
  };
  const config = { summarizerModel: "default", summarizerThinking: "off" };
  const result = await summarizeBatch(mkBatch(8), config, ctx, {
    onContextOverflow: (message) => { overflow = message; },
  });
  assert.equal(result, null);
  assert.equal(requests, 1);
  assert.match(overflow, /context window/);
  assert.deepEqual(notifications, []);
});

test("non-overflow failure still notifies; successful request is not split", async () => {
  const notifications = [];
  let stopReason = "error", errorMessage = "Invalid API key", requests = 0;
  const ctx = {
    model: { provider: "mock", id: "mock" },
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
      getProvider: () => ({ stream: () => {
        requests++;
        return {
          async *[Symbol.asyncIterator]() {},
          result: async () => ({
            role: "assistant", content: [{ type: "text", text: "short summary" }],
            stopReason, errorMessage, usage: { input: 5, output: 5 },
          }),
        };
      } }),
    },
  };
  const config = { summarizerModel: "default", summarizerThinking: "default" };
  const failed = await summarizeBatch(mkBatch(4), config, ctx, {
    onContextOverflow: () => assert.fail("Must not split non-overflow errors"),
  });
  assert.equal(failed, null);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  stopReason = "stop"; errorMessage = "";
  const success = await summarizeBatch(mkBatch(4), config, ctx, {
    onContextOverflow: () => assert.fail("Must not split successful requests"),
  });
  assert.equal(success.summaryText, "short summary");
  assert.equal(requests, 2);
  assert.equal(notifications.length, 1);
});
