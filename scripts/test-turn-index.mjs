/**
 * Regression tests for the multi-prompt turn-index bug.
 *
 * Pi's `turn_end` event carries an invocation-local `turnIndex` that is reset to
 * 0 on every `agent_start`, while the prune frontier and the session scanner
 * number assistant messages session-globally. Before the fix, live capture fed
 * the invocation-local number into `trimBatchToPendingRange()`, so every turn of
 * a second prompt compared as `turn 0 < frontier turn N` and was dropped: no
 * pending batches were registered and no notifications were shown, even though
 * `context_prune` (which re-scans the session) still worked.
 *
 * These tests drive the real extension entry point with a mocked Pi extension
 * API and a real in-memory SessionManager, so the live capture path is exercised
 * end to end. No network or real LLM is used.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const temp = mkdtempSync(join(process.cwd(), 'node_modules', '.pruner-turn-index-'));
// Isolate from the user's real Pi configuration before any module is imported,
// because config.ts resolves SETTINGS_PATH at import time.
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(temp, 'agent');
const piAiShim = join(temp, 'pi-ai-shim.mjs');
writeFileSync(piAiShim, 'export const normalizeContext = value => value;\n');

await build({
  entryPoints: ['index.ts'],
  outdir: temp,
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@earendil-works/pi-ai': piAiShim },
  external: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'],
  outExtension: { '.js': '.mjs' },
});
await build({
  entryPoints: ['src/types.ts', 'src/batch-capture.ts', 'src/frontier.ts'],
  outdir: join(temp, 'src'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui'],
  outExtension: { '.js': '.mjs' },
});

const createExtension = (await import(pathToFileURL(join(temp, 'index.mjs')))).default;
const { resolveSessionTurnIndex } = await import(pathToFileURL(join(temp, 'src', 'batch-capture.mjs')));
const frontierModule = await import(pathToFileURL(join(temp, 'src', 'frontier.mjs')));
// Present only in the fixed implementation; the pure-helper test is skipped otherwise.
const trimBatchToPendingRange = frontierModule.trimBatchToPendingRange ?? null;
const { CUSTOM_TYPE_SUMMARY, CUSTOM_TYPE_INDEX, CUSTOM_TYPE_FRONTIER, STATUS_WIDGET_ID } =
  await import(pathToFileURL(join(temp, 'src', 'types.mjs')));

const agentDir = join(temp, 'agent');
const settingsPath = join(agentDir, 'context-prune', 'settings.json');

function writeSettings(settings) {
  mkdirSync(join(agentDir, 'context-prune'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings));
}

// Mirrors the configuration from the bug report.
const agenticAuto = {
  enabled: true,
  showPruneStatusLine: true,
  showPruneStatusCost: true,
  summarizerModel: 'default',
  summarizerThinking: 'off',
  pruneOn: 'agentic-auto',
  batchingMode: 'agent-message',
  remindUnprunedCount: true,
  notifySkipped: true,
};

const RAW_RESULT_LENGTH = 600;

function rawResult(id) {
  return `raw output for ${id} `.repeat(40).slice(0, RAW_RESULT_LENGTH);
}

function createHarness(settings, session = SessionManager.inMemory(), summarize) {
  writeSettings(settings);

  const notifications = [];
  const statusUpdates = [];
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const activeTools = [];
  let summarizerCalls = 0;

  const pi = {
    on: (type, handler) => handlers.set(type, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer: () => {},
    appendEntry: (customType, data) => session.appendCustomEntry(customType, data),
    sendMessage: (message) =>
      session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details),
    getActiveTools: () => [...activeTools],
    setActiveTools: (next) => {
      activeTools.length = 0;
      activeTools.push(...next);
    },
  };

  const ctx = {
    sessionManager: session,
    model: { id: 'mock-model', provider: 'mock' },
    ui: {
      notify: (message, type = 'info') => notifications.push({ message, type }),
      setStatus: (id, text) => statusUpdates.push({ id, text }),
      setWidget: () => {},
      custom: async () => undefined,
    },
    modelRegistry: {
      find: () => ctx.model,
      getAvailable: () => [],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'dummy' }),
      getProvider: () => ({
        stream: (_model, context) => {
          summarizerCalls++;
          const prompt = context.messages[0].content[0].text;
          const ids = [...prompt.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1]);
          const reply = summarize ? summarize(prompt, ids) : `Summary of ${ids.length} tool calls: ${ids.join(', ')}`;
          // Regression tests can simulate a provider's structured failed
          // stream result without making any actual model requests.
          const failed = reply && typeof reply === 'object' && typeof reply.error === 'string';
          const text = failed ? '' : reply;
          const response = {
            role: 'assistant',
            provider: 'mock',
            model: 'mock-model',
            responseModel: 'mock-model',
            content: [{ type: 'text', text }],
            stopReason: failed ? 'error' : 'stop',
            errorMessage: failed ? reply.error : undefined,
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
          };
          return {
            async *[Symbol.asyncIterator]() {},
            result: async () => response,
          };
        },
      }),
    },
  };

  createExtension(pi);

  return { pi, ctx, session, notifications, statusUpdates, handlers, tools, commands, activeTools, summarizerCallCount: () => summarizerCalls };
}

function assistantMessage(text, toolCalls) {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolCalls.map((tc) => ({ type: 'toolCall', id: tc.id, name: tc.name, input: { id: tc.id } })),
    ],
    model: 'mock-model',
    provider: 'mock',
    timestamp: Date.now(),
    stopReason: 'toolUse',
  };
}

function toolResultMessage(tc) {
  return {
    role: 'toolResult',
    toolCallId: tc.id,
    content: [{ type: 'text', text: tc.result ?? rawResult(tc.id) }],
    isError: false,
    timestamp: Date.now(),
  };
}

/**
 * Emulate one user prompt. Pi resets its internal turn index on every prompt, so
 * `turnIndex` in the event always starts at 0 — exactly what the pruner used to
 * (wrongly) compare against the frontier.
 */
async function runPrompt(harness, promptText, turns, { cloneMessage = false } = {}) {
  harness.session.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: promptText }],
    timestamp: Date.now(),
  });
  const turnEnd = harness.handlers.get('turn_end');
  assert.ok(turnEnd, 'extension must register a turn_end handler');

  for (let index = 0; index < turns.length; index++) {
    const toolCalls = turns[index];
    const message = assistantMessage(`working on ${promptText} turn ${index}`, toolCalls);
    const results = toolCalls.map(toolResultMessage);

    // Pi persists the assistant message and its tool results before turn_end fires.
    harness.session.appendMessage(cloneMessage ? JSON.parse(JSON.stringify(message)) : message);
    for (const result of results) harness.session.appendMessage(result);

    await turnEnd({ type: 'turn_end', turnIndex: index, message, toolResults: results }, harness.ctx);
  }
}

async function prune(harness) {
  const tool = harness.tools.get('context_prune');
  assert.ok(tool, 'context_prune tool must be registered');
  const result = await tool.execute('prune-tool-call', {}, undefined, undefined, harness.ctx);
  // The tool wraps the FlushResult in `details`; return it so assertions read naturally.
  return result.details;
}

async function runCommand(harness, args) {
  const command = harness.commands.get('pruner');
  assert.ok(command, '/pruner command must be registered');
  await command.handler(args, harness.ctx);
}

function summaryEntries(session) {
  return session
    .getBranch()
    .filter((entry) => (entry.type === 'custom' || entry.type === 'custom_message') && entry.customType === CUSTOM_TYPE_SUMMARY);
}

function indexedToolCallIds(session) {
  const ids = [];
  for (const entry of session.getBranch()) {
    if (entry.type === 'custom' && entry.customType === CUSTOM_TYPE_INDEX) {
      for (const record of entry.data.toolCalls) ids.push({ id: record.toolCallId, turnIndex: record.turnIndex });
    }
  }
  return ids;
}

function frontierEntries(session) {
  return session
    .getBranch()
    .filter((entry) => entry.type === 'custom' && entry.customType === CUSTOM_TYPE_FRONTIER)
    .map((entry) => entry.data);
}

function pendingNotifications(notifications) {
  return notifications.filter((note) => /pending/i.test(note.message));
}

// ── Test A — the original bug ────────────────────────────────────────────────
test('A: live capture queues batches and notifies for a second prompt in the same session', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);

  // Prompt 1: invocation-local turn indices 0, 1
  await runPrompt(harness, 'prompt 1', [
    [{ id: 'a1', name: 'read' }, { id: 'a2', name: 'read' }],
    [{ id: 'a3', name: 'bash' }],
  ]);

  assert.equal(pendingNotifications(harness.notifications).length, 2, 'prompt 1 turns must be queued');

  const first = await prune(harness);
  assert.equal(first.ok, true, 'first prune must run');
  assert.equal(first.toolCallCount, 3);
  assert.equal(summaryEntries(harness.session).length, 1);

  const firstFrontier = frontierEntries(harness.session).at(-1);
  assert.ok(firstFrontier, 'frontier must be persisted');

  // Prompt 2: Pi resets its turn index, so these events also start at turnIndex 0.
  const notificationsBefore = harness.notifications.length;
  await runPrompt(harness, 'prompt 2', [
    [{ id: 'b1', name: 'read' }, { id: 'b2', name: 'bash' }],
    [{ id: 'b3', name: 'edit' }],
  ]);

  const newNotifications = harness.notifications.slice(notificationsBefore);
  assert.equal(
    pendingNotifications(newNotifications).length,
    2,
    'prompt 2 turns must still be registered as pending after the frontier advanced'
  );
  assert.match(harness.statusUpdates.at(-1).text, /pending/);

  const second = await prune(harness);
  assert.equal(second.ok, true);
  assert.equal(second.toolCallCount, 3, 'only the new prompt tool calls are summarized');

  // Session-global turn identity: the second prompt's turns are numbered after the first.
  const indexed = indexedToolCallIds(harness.session);
  const secondPromptIds = indexed.filter((record) => record.id.startsWith('b'));
  assert.ok(secondPromptIds.every((record) => record.turnIndex > firstFrontier.lastAttemptedTurnIndex));

  // Nothing is summarized twice.
  assert.equal(indexed.map((record) => record.id).length, 6);
  assert.equal(new Set(indexed.map((record) => record.id)).size, 6);
  assert.equal(summaryEntries(harness.session).length, 2);

  const secondFrontier = frontierEntries(harness.session).at(-1);
  assert.ok(secondFrontier.lastAttemptedTurnIndex > firstFrontier.lastAttemptedTurnIndex);
});

// ── Test B — three consecutive prompts ────────────────────────────────────────
test('B: three consecutive prompts each register their own pending batches', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);

  for (let prompt = 1; prompt <= 3; prompt++) {
    await runPrompt(harness, `prompt ${prompt}`, [
      [{ id: `p${prompt}a`, name: 'read' }, { id: `p${prompt}b`, name: 'bash' }],
    ]);
    assert.equal(pendingNotifications(harness.notifications).length, prompt, `prompt ${prompt} queued a batch`);

    const result = await prune(harness);
    assert.equal(result.ok, true);
    assert.equal(result.toolCallCount, 2, `prompt ${prompt} prune processed exactly its own tool calls`);
  }

  const indexed = indexedToolCallIds(harness.session).map((record) => record.id);
  assert.equal(indexed.length, 6);
  assert.equal(new Set(indexed).size, 6);
  assert.equal(summaryEntries(harness.session).length, 3);
});

// ── Test C — several tool calls in one assistant message ──────────────────────
test('C: multiple tool calls of one assistant message share one consistent turn identity', async () => {
  const harness = createHarness({ ...agenticAuto, batchingMode: 'turn' });
  await harness.handlers.get('session_start')({}, harness.ctx);

  await runPrompt(harness, 'prompt 1', [
    [{ id: 'm1', name: 'read' }, { id: 'm2', name: 'read' }, { id: 'm3', name: 'bash' }],
    [{ id: 'm4', name: 'edit' }],
  ]);
  const result = await prune(harness);
  assert.equal(result.ok, true);
  assert.equal(result.batchCount, 2, 'per-turn batching produces one batch per assistant message');
  assert.equal(result.toolCallCount, 4);

  const indexed = indexedToolCallIds(harness.session);
  assert.equal(indexed.length, 4);
  const turnIndexes = new Set(indexed.map((record) => record.turnIndex));
  assert.equal(turnIndexes.size, 2, 'all tool calls of a message share the assistant-message index');

  // Re-running a prune must not re-summarize the same tool calls.
  const again = await prune(harness);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'empty');
});

test('C2: agent-message batching merges the turns of one user prompt into one summary', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);

  await runPrompt(harness, 'prompt 1', [
    [{ id: 'g1', name: 'read' }],
    [{ id: 'g2', name: 'bash' }],
    [{ id: 'g3', name: 'edit' }],
  ]);
  const result = await prune(harness);
  assert.equal(result.ok, true);
  assert.equal(result.batchCount, 1);
  assert.equal(result.toolCallCount, 3);

  await runPrompt(harness, 'prompt 2', [[{ id: 'g4', name: 'read' }, { id: 'g5', name: 'bash' }]]);
  const second = await prune(harness);
  assert.equal(second.ok, true);
  assert.equal(second.batchCount, 1);
  assert.equal(second.toolCallCount, 2, 'only the second prompt is merged, not the first');

  const ids = indexedToolCallIds(harness.session).map((record) => record.id);
  assert.deepEqual(ids, ['g1', 'g2', 'g3', 'g4', 'g5']);
});

// ── Test D — pruning in the middle of a longer tool-call sequence ─────────────
test('D: a partial prune keeps the not-yet-processed tool calls of the same turn', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);

  harness.session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'prompt 1' }], timestamp: Date.now() });

  // Six tool calls, but only the first three have results at prune time.
  const toolCalls = Array.from({ length: 6 }, (_, i) => ({ id: `d${i + 1}`, name: 'bash' }));
  const message = assistantMessage('long tool chain', toolCalls);
  harness.session.appendMessage(message);
  for (const tc of toolCalls.slice(0, 3)) harness.session.appendMessage(toolResultMessage(tc));

  const first = await prune(harness);
  assert.equal(first.ok, true);
  assert.equal(first.toolCallCount, 3, 'only completed tool calls are summarized mid-chain');
  const frontier = frontierEntries(harness.session).at(-1);
  assert.equal(frontier.lastAttemptedToolCallId, 'd3');

  // The rest of the chain finishes; the live turn_end for the same message fires.
  for (const tc of toolCalls.slice(3)) harness.session.appendMessage(toolResultMessage(tc));
  await harness.handlers.get('turn_end')(
    { type: 'turn_end', turnIndex: 0, message, toolResults: toolCalls.map(toolResultMessage) },
    harness.ctx
  );
  assert.equal(pendingNotifications(harness.notifications).length, 1, 'the remaining calls are still queued');

  const second = await prune(harness);
  assert.equal(second.ok, true);
  assert.equal(second.toolCallCount, 3, 'the remaining calls of the same turn are summarized next');

  const ids = indexedToolCallIds(harness.session).map((record) => record.id);
  assert.deepEqual(ids, ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
  assert.equal(frontierEntries(harness.session).at(-1).lastAttemptedToolCallId, 'd6');
});

// ── Test E — skipped oversized summary ────────────────────────────────────────
test('E: an oversized skipped summary still advances the frontier without blocking later prompts', async () => {
  const harness = createHarness({ ...agenticAuto, batchingMode: 'turn' }, SessionManager.inMemory(), () => 'x'.repeat(5000));
  await harness.handlers.get('session_start')({}, harness.ctx);

  // Three turns so the frontier turn index is > 0, which is what made the bug visible.
  await runPrompt(harness, 'prompt 1', [
    [{ id: 'e1', name: 'read' }],
    [{ id: 'e2', name: 'read' }],
    [{ id: 'e3', name: 'bash' }],
  ]);
  const result = await prune(harness);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'skipped-oversized');
  assert.equal(result.batchCount, 3);
  assert.equal(summaryEntries(harness.session).length, 0, 'oversized summaries are not persisted');

  const frontier = frontierEntries(harness.session).at(-1);
  assert.ok(frontier, 'frontier is still advanced for skipped summaries');
  assert.equal(frontier.outcome, 'skipped-oversized');
  assert.equal(frontier.lastAttemptedTurnIndex, 2);

  // The next prompt must not be rejected by the frontier.
  await runPrompt(harness, 'prompt 2', [[{ id: 'e4', name: 'read' }]], { cloneMessage: true });
  assert.equal(pendingNotifications(harness.notifications).length, 4);

  const second = await prune(harness);
  assert.equal(second.ok, true);
  assert.equal(second.reason, 'skipped-oversized');
  assert.equal(second.toolCallCount, 1);
  assert.ok(frontierEntries(harness.session).at(-1).lastAttemptedTurnIndex > 2);
});

// ── Test F — session reconstruction ───────────────────────────────────────────
test('F: a new extension instance over an existing session registers new tool calls', async () => {
  const session = SessionManager.inMemory();
  const first = createHarness(agenticAuto, session);
  await first.handlers.get('session_start')({}, first.ctx);

  await runPrompt(first, 'prompt 1', [[{ id: 'f1', name: 'read' }, { id: 'f2', name: 'bash' }], [{ id: 'f0', name: 'read' }]]);
  const firstResult = await prune(first);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.toolCallCount, 3);

  // "Reload" the session: fresh indexer, fresh frontier, same persisted history.
  const second = createHarness(agenticAuto, session);
  await second.handlers.get('session_start')({}, second.ctx);

  await runPrompt(second, 'prompt 2', [[{ id: 'f3', name: 'edit' }], [{ id: 'f4', name: 'bash' }]]);
  assert.equal(pendingNotifications(second.notifications).length, 2);

  const result = await prune(second);
  assert.equal(result.ok, true);
  assert.equal(result.toolCallCount, 2, 'only the new tool calls are summarized after reload');

  const ids = indexedToolCallIds(session).map((record) => record.id);
  assert.deepEqual(ids, ['f1', 'f2', 'f0', 'f3', 'f4']);
  assert.equal(summaryEntries(session).length, 2, 'previous summary history is preserved');
});

// ── Test G — branch switching ─────────────────────────────────────────────────
test('G: switching to another branch does not reuse a stale frontier', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);

  // Branch A: two turns, pruned — frontier at session-global turn 1.
  await runPrompt(harness, 'prompt 1', [
    [{ id: 'g1', name: 'read' }],
    [{ id: 'g2', name: 'bash' }],
  ]);
  await prune(harness);
  assert.ok(frontierEntries(harness.session).length === 1);

  const prompt1EntryId = harness.session
    .getBranch()
    .find((entry) => entry.type === 'message' && entry.message?.role === 'user').id;

  // Navigate back to the first user message and take a different branch.
  harness.session.branch(prompt1EntryId);
  await harness.handlers.get('session_tree')({}, harness.ctx);
  const notificationsBefore = harness.notifications.length;

  await runPrompt(harness, 'prompt 2 (new branch)', [[{ id: 'g3', name: 'read' }]]);
  assert.equal(
    pendingNotifications(harness.notifications.slice(notificationsBefore)).length,
    1,
    'the new branch turn is not rejected by the frontier of the abandoned branch'
  );

  const result = await prune(harness);
  assert.equal(result.ok, true);
  assert.equal(result.toolCallCount, 1);

  const branch = harness.session.getBranch();
  const indexedHere = branch
    .filter((entry) => entry.type === 'custom' && entry.customType === CUSTOM_TYPE_INDEX)
    .flatMap((entry) => entry.data.toolCalls.map((record) => record.toolCallId));
  assert.deepEqual(indexedHere, ['g3'], 'only entries of the current branch are summarized');
});

// ── Test H — missing / unresolved message entry id ────────────────────────────
test('H: an unresolvable entry id falls back to the session scan without duplicating work', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);

  harness.session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'prompt 1' }], timestamp: Date.now() });
  const toolCalls = [{ id: 'h1', name: 'read' }, { id: 'h2', name: 'bash' }];
  const persisted = assistantMessage('reading files', toolCalls);
  harness.session.appendMessage(persisted);
  for (const tc of toolCalls) harness.session.appendMessage(toolResultMessage(tc));

  // The host reports an entry id we cannot resolve, and the event message is a
  // reconstruction whose tool-call ids are not in the branch.
  const eventMessage = assistantMessage('reading files', [{ id: 'h3', name: 'read' }]);
  await harness.handlers.get('turn_end')(
    {
      type: 'turn_end',
      turnIndex: 0,
      message: eventMessage,
      messageEntryId: 'no-such-entry',
      toolResults: [toolResultMessage({ id: 'h3', name: 'read' })],
    },
    harness.ctx
  );

  assert.equal(pendingNotifications(harness.notifications).length, 1, 'the fallback still registers the pending work');

  await prune(harness);
  const ids = indexedToolCallIds(harness.session).map((record) => record.id);
  assert.deepEqual(ids, ['h1', 'h2'], 'no duplicate or invalid frontier comparison');

  // Running the same turn_end twice must not queue the batch twice.
  await harness.handlers.get('turn_end')(
    {
      type: 'turn_end',
      turnIndex: 0,
      message: eventMessage,
      messageEntryId: 'no-such-entry',
      toolResults: [toolResultMessage({ id: 'h3', name: 'read' })],
    },
    harness.ctx
  );
  assert.equal(pendingNotifications(harness.notifications).length, 1);
});

test('H2: resolveSessionTurnIndex matches by entry id, object identity, or tool-call ids', () => {
  const branch = [
    { id: 'e0', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { id: 'e1', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash' }] } },
    { id: 'e2', type: 'message', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'out' }] } },
    { id: 'e3', type: 'custom', customType: 'x', data: {} },
    { id: 'e4', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];

  assert.equal(resolveSessionTurnIndex(branch, { entryId: 'e4' }), 1, 'counts assistant messages only');
  assert.equal(resolveSessionTurnIndex(branch, { entryId: 'e1' }), 0);
  assert.equal(resolveSessionTurnIndex(branch, { message: branch[4].message }), 1);
  assert.equal(resolveSessionTurnIndex(branch, { message: JSON.parse(JSON.stringify(branch[1].message)) }), 0);
  assert.equal(resolveSessionTurnIndex(branch, { entryId: 'nope', message: { role: 'assistant', content: [] } }), null);
  assert.equal(resolveSessionTurnIndex(branch, {}), null, 'no identity at all is not a valid turn');

  // A turn whose assistant message is not persisted yet is after all known ones.
  assert.equal(
    resolveSessionTurnIndex(branch, { message: assistantMessage('next turn', [{ id: 't2', name: 'bash' }]) }),
    2
  );
});

// ── Test I — notifications ────────────────────────────────────────────────────
test('I: pending notifications and footer status updates continue across prompts', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);

  await runPrompt(harness, 'prompt 1', [[{ id: 'i1', name: 'read' }], [{ id: 'i0', name: 'bash' }]]);
  await prune(harness);

  const before = harness.notifications.length;
  await runPrompt(harness, 'prompt 2', [[{ id: 'i2', name: 'bash' }], [{ id: 'i3', name: 'read' }]]);

  const after = harness.notifications.slice(before);
  assert.equal(after.length, 2);
  assert.ok(after.every((note) => /pending/i.test(note.message)));
  assert.ok(harness.statusUpdates.at(-1).id === STATUS_WIDGET_ID);
  assert.match(harness.statusUpdates.at(-1).text, /2 ↻ pending/);
});

// ── Test J — other pruning modes keep working ─────────────────────────────────
test('J: every-turn mode flushes each turn and never leaves a pending queue', async () => {
  const harness = createHarness({ ...agenticAuto, pruneOn: 'every-turn' });
  await harness.handlers.get('session_start')({}, harness.ctx);

  await runPrompt(harness, 'prompt 1', [[{ id: 'j1', name: 'read' }], [{ id: 'j2', name: 'bash' }]]);
  await runPrompt(harness, 'prompt 2', [[{ id: 'j3', name: 'edit' }]]);

  const ids = indexedToolCallIds(harness.session).map((record) => record.id);
  assert.deepEqual(ids, ['j1', 'j2', 'j3']);
  assert.equal(summaryEntries(harness.session).length, 3);
  assert.equal(pendingNotifications(harness.notifications).length, 0);
});

test('J: agent-message mode flushes on the final text-only assistant message', async () => {
  const harness = createHarness({ ...agenticAuto, pruneOn: 'agent-message' });
  await harness.handlers.get('session_start')({}, harness.ctx);

  await runPrompt(harness, 'prompt 1', [[{ id: 'k1', name: 'read' }, { id: 'k2', name: 'bash' }]]);
  const finalMessage = { role: 'assistant', content: [{ type: 'text', text: 'all done' }], model: 'mock-model', timestamp: Date.now(), stopReason: 'stop' };
  harness.session.appendMessage(finalMessage);
  await harness.handlers.get('message_end')({ type: 'message_end', message: finalMessage }, harness.ctx);

  assert.equal(summaryEntries(harness.session).length, 1);
  assert.deepEqual(indexedToolCallIds(harness.session).map((record) => record.id), ['k1', 'k2']);

  // Second prompt in the same session still registers and flushes.
  await runPrompt(harness, 'prompt 2', [[{ id: 'k3', name: 'read' }]]);
  const final2 = { role: 'assistant', content: [{ type: 'text', text: 'finished' }], model: 'mock-model', timestamp: Date.now(), stopReason: 'stop' };
  harness.session.appendMessage(final2);
  await harness.handlers.get('message_end')({ type: 'message_end', message: final2 }, harness.ctx);

  assert.equal(summaryEntries(harness.session).length, 2);
  assert.deepEqual(indexedToolCallIds(harness.session).map((record) => record.id), ['k1', 'k2', 'k3']);
});

test('J: on-demand mode flushes via /pruner now for a second prompt', async () => {
  const harness = createHarness({ ...agenticAuto, pruneOn: 'on-demand' });
  await harness.handlers.get('session_start')({}, harness.ctx);

  await runPrompt(harness, 'prompt 1', [[{ id: 'n1', name: 'read' }]]);
  await runCommand(harness, 'now');

  await runPrompt(harness, 'prompt 2', [[{ id: 'n2', name: 'bash' }]]);
  await runCommand(harness, 'now');

  assert.deepEqual(indexedToolCallIds(harness.session).map((record) => record.id), ['n1', 'n2']);
  assert.equal(summaryEntries(harness.session).length, 2);
});

test('J: on-context-tag mode flushes when context_checkpoint runs', async () => {
  const harness = createHarness({ ...agenticAuto, pruneOn: 'on-context-tag' });
  await harness.handlers.get('session_start')({}, harness.ctx);

  await runPrompt(harness, 'prompt 1', [[{ id: 'c1', name: 'read' }]]);
  await harness.handlers.get('tool_execution_end')({ type: 'tool_execution_end', toolName: 'context_checkpoint', toolCallId: 'tag1' }, harness.ctx);
  await runPrompt(harness, 'prompt 2', [[{ id: 'c2', name: 'bash' }]]);
  await harness.handlers.get('tool_execution_end')({ type: 'tool_execution_end', toolName: 'context_checkpoint', toolCallId: 'tag2' }, harness.ctx);

  assert.deepEqual(indexedToolCallIds(harness.session).map((record) => record.id), ['c1', 'c2']);
});

test('J: /pruner status and /pruner tree still report the pruned history', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);
  await runPrompt(harness, 'prompt 1', [[{ id: 's1', name: 'read' }, { id: 's2', name: 'bash' }]]);
  await prune(harness);
  await runPrompt(harness, 'prompt 2', [[{ id: 's3', name: 'read' }]]);
  await prune(harness);

  await runCommand(harness, 'status');
  await runCommand(harness, 'stats');
  await runCommand(harness, 'tree');

  const status = harness.notifications.find((note) => /Prune trigger/i.test(note.message) || /agentic/i.test(note.message));
  assert.ok(status, '/pruner status must produce output');
  assert.equal(summaryEntries(harness.session).length, 2);
  assert.equal(indexedToolCallIds(harness.session).length, 3);
});

test('J: context_tree_query can recover a pruned tool call from a second prompt', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);
  await runPrompt(harness, 'prompt 1', [[{ id: 'q1', name: 'read' }]]);
  await prune(harness);
  await runPrompt(harness, 'prompt 2', [[{ id: 'q2', name: 'bash' }]]);
  await prune(harness);

  const query = harness.tools.get('context_tree_query');
  assert.ok(query, 'context_tree_query tool must be registered');
  const result = await query.execute('query-call', { toolCallIds: ['q1', 'q2'] }, undefined, undefined, harness.ctx);
  const text = result.content[0].text;
  assert.match(text, /raw output for q1/);
  assert.match(text, /raw output for q2/);
});

// ── Pure frontier helper semantics ────────────────────────────────────────────
test('trimBatchToPendingRange keeps mid-turn remainder and drops fully-processed turns', (t) => {
  if (!trimBatchToPendingRange) {
    t.skip('frontier helper is not exported by this implementation');
    return;
  }
  const indexer = { isSummarized: (id) => id === 'done1' };
  const frontier = {
    lastAttemptedToolCallId: 'a2',
    lastAttemptedToolName: 'bash',
    lastAttemptedTurnIndex: 5,
    lastAttemptedTimestamp: 0,
    attemptedBatchCount: 1,
    attemptedToolCallCount: 2,
    rawCharCount: 0,
    summaryCharCount: 0,
    outcome: 'summarized',
  };

  assert.equal(
    trimBatchToPendingRange({ turnIndex: 4, timestamp: 0, assistantText: '', toolCalls: [{ toolCallId: 'x', toolName: 'bash', args: {}, resultText: 'y', isError: false }] }, frontier, indexer),
    null,
    'an earlier session-global turn is behind the frontier'
  );

  const sameTurn = trimBatchToPendingRange(
    {
      turnIndex: 5,
      timestamp: 0,
      assistantText: '',
      toolCalls: [
        { toolCallId: 'done1', toolName: 'read', args: {}, resultText: 'r', isError: false },
        { toolCallId: 'a2', toolName: 'bash', args: {}, resultText: 'r', isError: false },
        { toolCallId: 'a3', toolName: 'bash', args: {}, resultText: 'r', isError: false },
      ],
    },
    frontier,
    indexer
  );
  assert.deepEqual(sameTurn.toolCalls.map((tc) => tc.toolCallId), ['a3']);

  const laterTurn = trimBatchToPendingRange(
    { turnIndex: 6, timestamp: 0, assistantText: '', toolCalls: [{ toolCallId: 'b1', toolName: 'bash', args: {}, resultText: 'y', isError: false }] },
    frontier,
    indexer
  );
  assert.deepEqual(laterTurn.toolCalls.map((tc) => tc.toolCallId), ['b1']);

  const noFrontier = trimBatchToPendingRange(
    { turnIndex: 0, timestamp: 0, assistantText: '', toolCalls: [{ toolCallId: 'z', toolName: 'bash', args: {}, resultText: 'y', isError: false }] },
    null,
    indexer
  );
  assert.deepEqual(noFrontier.toolCalls.map((tc) => tc.toolCallId), ['z']);
});

// ── Recursive overflow recovery — real extension integration ────────────────
test('K: context overflow splits an agent-message batch left-first with persisted order', async () => {
  const attempts = [];
  const harness = createHarness(agenticAuto, SessionManager.inMemory(), (_prompt, ids) => {
    attempts.push(ids.join(','));
    return ids.length > 2
      ? { error: 'request exceeds the context window: prompt too long' }
      : `Summary for ${ids.join(', ')}`;
  });
  await harness.handlers.get('session_start')({}, harness.ctx);

  await runPrompt(harness, 'overflow prompt', [
    [{ id: 'k1', name: 'read' }, { id: 'k2', name: 'read' }],
    [{ id: 'k3', name: 'read' }, { id: 'k4', name: 'read' }],
    [{ id: 'k5', name: 'read' }, { id: 'k6', name: 'read' }],
    [{ id: 'k7', name: 'read' }, { id: 'k8', name: 'read' }],
  ]);
  const result = await prune(harness);
  assert.equal(result.ok, true);
  assert.equal(result.toolCallCount, 8);
  assert.equal(result.batchCount, 4);
  assert.equal(harness.summarizerCallCount(), 7);
  assert.deepEqual(attempts, [
    'k1,k2,k3,k4,k5,k6,k7,k8',
    'k1,k2,k3,k4',
    'k1,k2',
    'k3,k4',
    'k5,k6,k7,k8',
    'k5,k6',
    'k7,k8',
  ]);
  assert.deepEqual(
    indexedToolCallIds(harness.session).map((record) => record.id),
    ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']
  );
  assert.deepEqual(
    frontierEntries(harness.session).at(-1).lastAttemptedToolCallId,
    'k8'
  );
  assert.equal(frontierEntries(harness.session).at(-1).lastAttemptedTurnIndex, 3);
  assert.equal(summaryEntries(harness.session).length, 4);
  assert.equal(harness.notifications.filter((note) => note.type === 'error').length, 0);

  // Reload from persisted entries, then confirm the original calls are not
  // summarized twice and new work can still advance the session-global frontier.
  const restarted = createHarness(agenticAuto, harness.session);
  await restarted.handlers.get('session_start')({}, restarted.ctx);
  assert.equal((await prune(restarted)).reason, 'empty');
  await runPrompt(restarted, 'next prompt', [[{ id: 'k9', name: 'read' }]]);
  const next = await prune(restarted);
  assert.equal(next.ok, true);
  assert.deepEqual(
    indexedToolCallIds(restarted.session).map((record) => record.id),
    ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']
  );
  assert.ok(frontierEntries(restarted.session).at(-1).lastAttemptedTurnIndex > 3);
});

test('K1: a normal large-enough batch still uses exactly one request', async () => {
  const harness = createHarness(agenticAuto);
  await harness.handlers.get('session_start')({}, harness.ctx);
  await runPrompt(harness, 'normal prompt', [
    [{ id: 'normal1', name: 'read' }, { id: 'normal2', name: 'read' }],
    [{ id: 'normal3', name: 'read' }, { id: 'normal4', name: 'read' }],
    [{ id: 'normal5', name: 'read' }, { id: 'normal6', name: 'read' }],
    [{ id: 'normal7', name: 'read' }, { id: 'normal8', name: 'read' }],
  ]);
  const result = await prune(harness);
  assert.equal(result.ok, true);
  assert.equal(result.batchCount, 1);
  assert.equal(harness.summarizerCallCount(), 1, 'successful full request requires no additional attempts');
  assert.equal(summaryEntries(harness.session).length, 1);
});

test('K2: a later non-context error retains successful prefix and retries only pending work', async () => {
  let failMiddle = true;
  const attempts = [];
  const session = SessionManager.inMemory();
  const harness = createHarness(agenticAuto, session, (_prompt, ids) => {
    attempts.push(ids.join(','));
    if (failMiddle && ids.join(',') === 'v3,v4') return { error: 'invalid API key' };
    return ids.length > 2
      ? { error: 'request exceeds the context window' }
      : `Summary for ${ids.join(', ')}`;
  });
  await harness.handlers.get('session_start')({}, harness.ctx);
  await runPrompt(harness, 'partial failure', [
    [{ id: 'v1', name: 'read' }, { id: 'v2', name: 'read' }],
    [{ id: 'v3', name: 'read' }, { id: 'v4', name: 'read' }],
    [{ id: 'v5', name: 'read' }, { id: 'v6', name: 'read' }],
    [{ id: 'v7', name: 'read' }, { id: 'v8', name: 'read' }],
  ]);
  const partial = await prune(harness);
  assert.equal(partial.ok, true);
  assert.deepEqual(indexedToolCallIds(session).map((r) => r.id), ['v1', 'v2']);
  assert.equal(frontierEntries(session).at(-1).lastAttemptedToolCallId, 'v2');
  assert.equal(frontierEntries(session).at(-1).lastAttemptedTurnIndex, 0);
  assert.equal(harness.notifications.filter((note) => note.type === 'error').length, 1);
  assert.deepEqual(attempts.slice(0, 4), [
    'v1,v2,v3,v4,v5,v6,v7,v8', 'v1,v2,v3,v4', 'v1,v2', 'v3,v4'
  ]);
  assert.ok(!attempts.includes('v5,v6,v7,v8'), 'do not attempt later half after earlier failure');

  failMiddle = false;
  const restarted = createHarness(agenticAuto, session, (_prompt, ids) => (
    ids.length > 2
      ? { error: 'request exceeds the context window' }
      : `Summary for ${ids.join(', ')}`
  ));
  await restarted.handlers.get('session_start')({}, restarted.ctx);
  const recovered = await prune(restarted);
  assert.equal(recovered.ok, true);
  assert.deepEqual(indexedToolCallIds(session).map((r) => r.id), [
    'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'
  ]);
  assert.equal(frontierEntries(session).at(-1).lastAttemptedToolCallId, 'v8');
  assert.equal(frontierEntries(session).at(-1).lastAttemptedTurnIndex, 3);
});

process.on('exit', () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(temp, { recursive: true, force: true });
});
