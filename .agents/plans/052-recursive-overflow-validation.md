# 052 — Recursive context-overflow splitting: testing and validation roadmap

**Status:** Planned; no checks in this roadmap have been executed by writing the plan.  
**Code branch:** `fix/recursive-overflow-splitting` (based on `fix/multi-prompt-turn-index`).  
**Scope:** Validate recursive left-first binary splitting of tool-call batches after a **recognized** summarizer context-window overflow; do not broaden the implementation into token-budget batching or change trigger/batching defaults.  
**Safety:** Local checks and disposable sessions only; **never run GitHub Actions**, edit release workflows, or use the production session as a test fixture.  
**Decision rule:** Pass each gate in order; investigate regressions before proceeding to a costlier gate.

## Goal and invariants

The extension must make exactly one summarizer request when the initial request succeeds. On confirmed context overflow it divides the **ordered list of complete tool calls** at `Math.ceil(n / 2)`, recursively processes **all of the first half before the second**, and maintains the original order when persisting summaries. It does not sort calls, estimate tokens, or assume any model-specific context limit.

**Required invariants:**

- **No loss, duplicates, or reordering.** The concatenation of persisted split leaves equals the original ordered sequence for all successfully processed calls.
- **Correct frontier.** It advances no further than the last contiguous completed range; the next retry or session reload must still see unfinished calls. Session-global turn indices are never reset on a split.
- **Recovery.** Every indexed tool result remains recoverable through `context_tree_query`; original raw session outputs are not changed.
- **Error containment.** A recognized context overflow is silent while recovery succeeds. Authentication, rate-limit, generic HTTP 400, network, and other failures are **not** mistaken for overflow.
- **No change on success.** The non-overflow path keeps its existing number of requests, batching modes, summaries, and UI behavior.
- **Safe terminal condition.** A one-tool-call batch cannot be split again; it remains unpruned and the user receives an actionable warning.
- **Provider neutrality.** The algorithm needs no special tokenizer, token threshold, or provider configuration.

## Gate 0 — Prepare isolated local workspace and evidence folder [P0]

- [ ] Confirm the existing working checkout has no uncommitted work at risk; do not switch branches or overwrite it.
- [ ] Fetch the feature branch and create a separate disposable Git worktree; note the exact commit SHA.
- [ ] Confirm Node, npm, `pi-local`, and the selected Pi model/provider versions.
- [ ] Keep provider credentials out of logs and test session archives.
- [ ] Prepare an evidence directory containing timestamps, branch SHA, command exit codes, test output, and eventually redacted session diagnostics.
- [ ] Record the baseline for the earlier multi-prompt bug from `fix/multi-prompt-turn-index` when useful; do not alter that branch.

Suggested commands (from an existing clone):

```bash
cd ~/workspace/pi-context-prune
git status --short
git fetch origin
git worktree add --detach ../pi-context-prune-split-validation origin/fix/recursive-overflow-splitting
cd ../pi-context-prune-split-validation
git rev-parse HEAD
node --version
npm --version
command -v pi-local
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pruner-validation.XXXXXX")"
chmod 700 "$TEST_ROOT"
printf 'Evidence directory: %s\n' "$TEST_ROOT"
```

There is no committed package lockfile in the checked branch. Install development dependencies **only in this worktree** without writing a lockfile:

```bash
npm install --ignore-scripts --no-save --package-lock=false
```

## Gate 1 — Build, package, and existing regressions [P0; no provider calls]

- [ ] Run `npm run check` (build, packaging check, and full Node test suite) and record the exit code.
- [ ] Run `node --test scripts/test-recursive-split.mjs` individually for readable failure reports.
- [ ] Run `node --test scripts/test-turn-index.mjs` individually to guard the earlier multi-prompt fix.
- [ ] Confirm `git status --short` shows no unexpected tracked changes.
- [ ] Inspect `dist/index.js` existence and the built extension path in `package.json`; ensure tests exercise the current feature branch rather than a stale installed copy.
- [ ] Note: esbuild transpilation is not a TypeScript semantic type-check. If a TypeScript checker is available, run a separate project-appropriate type check rather than claiming the build proves type safety.

```bash
set -o pipefail
npm run check 2>&1 | tee "$TEST_ROOT/npm-check.log"
node --test scripts/test-recursive-split.mjs 2>&1 | tee "$TEST_ROOT/recursive-tests.log"
node --test scripts/test-turn-index.mjs 2>&1 | tee "$TEST_ROOT/turn-tests.log"
git status --short
```

**Pass:** All commands exit zero; no packaging errors; existing multi-prompt tests remain green.

## Gate 2 — Deterministic split unit-test matrix [P0; mocked provider]

| ID | Input and simulated provider behavior | Expected outcome |
|---|---|---|
| U1 | 8 calls, full attempt succeeds | **1** total request; no split; one persisted summary |
| U2 | 8 calls, only groups of 2 or fewer succeed | Requests in order: `1–8, 1–4, 1–2, 3–4, 5–8, 5–6, 7–8`; four summaries |
| U3 | 417 calls, groups of at most 105 succeed | Contiguous chronological leaves covering **all 417 exactly once**; correct source-turn metadata |
| U4 | Odd-size batch, e.g. 5 | Split `1–3` / `4–5` and recurse; no missing or duplicate call |
| U5 | Several calls in one assistant turn, split across that turn | Stable turn identity and call-ID boundary; next prune sees the unprocessed remainder |
| U6 | One call still overflows | No further split; warning; original remains accessible |
| U7 | Failure on a left sub-batch that is **not** overflow | Stop recursion; do not try its right sibling; preserve all unfinished calls |
| U8 | Overflow signaled via `stopReason: "error"` or stream throw | Equivalent recovery; usage for any returned provider response still accounted for |
| U9 | Generic HTTP 400, authentication, 429, network failure | No splitting, normal error handling |
| U10 | Context overflow warning during eventual success | No `pruner: summarization failed` UI error for recoverable rejection |
| U11 | Empty list or invalid batch metadata | Explicit safe result; no infinite recursion |
| U12 | Repeated failures / changing model limits | Recursion terminates and never retries an unchanged overflowing multi-call range indefinitely |

**Additional assertions:** Inspect the exact tool-call-ID sequence in every attempted prompt and persisted index, not merely summary count. Verify that `sourceTurnIndex`/`sourceTimestamp` survive scanning, `agent-message` grouping, and slicing; alias mapping remains unique and consistent. Treat the multi-turn and same-turn variants separately.

## Gate 3 — Full extension integration with an in-memory Pi session [P0; mocked provider]

Use `scripts/test-turn-index.mjs`'s real extension-entry-point harness and `SessionManager.inMemory()`, not just isolated helper calls.

- [ ] A normal successful request produces one provider call and one indexed summary (current K1 test).
- [ ] A full-batch rejection produces sequential left-first retries and persisted summaries in ascending call-ID order (current K test).
- [ ] Verify every `context-prune-index` entry, every hidden `context-prune-summary`, summary short ref, and last `context-prune-frontier` record.
- [ ] Force a non-overflow failure after the first successful split leaf: only the contiguous prefix is indexed, its frontier ends at the correct call, and a resumed session finishes without duplicates (current K2 test).
- [ ] Repeat partial failure **inside one assistant turn**, then restart/reload; check the exact remaining ID range.
- [ ] Test both `delivery: "runtime"` (`context_prune`) and `delivery: "session"` (e.g. `on-demand`/`every-turn`).
- [ ] Exercise `/pruner now`'s sequential progress rows and the `context_prune` tool's streamed progress independently.
- [ ] Switch session branches and test that discarded-branch frontier/index entries never contaminate the new branch.
- [ ] Simulate `AbortSignal` firing before first attempt, during stream, and **after one successful split leaf**.
- [ ] Simulate a failure while appending a summary/index/frontier entry; verify retry safety.
- [ ] Verify a summary whose rendered text exceeds raw output is skipped under the existing protective rule, without skipping a later unresolved range.
- [ ] Confirm `context_tree_query` recovers exact original raw output for first, middle, and last successful leaf after reloading the session.
- [ ] Test multiple original batches where an early one fails and a later one's provider request succeeds. Confirm whether the later result is persisted or knowingly discarded; prevent claiming successful-sibling persistence that the code does not provide.

**Known implementation risk to resolve before approval:** The current `index.ts` collects successful split results in memory, then writes summaries after the retry sequence completes. An abort during that sequence may discard already generated half-summaries and cause paid/expensive work to be repeated. This is not automatically data loss, but it fails the stronger requirement to *persist each successful half immediately*. Add a test, document actual behavior, and decide whether to change persistence or explicitly accept the limitation. Do not mark this invariant verified from the existing K test alone.

**Pass:** End-to-end capture → summary → index → frontier → context filtering → recovery works under all supported flush paths and restart/branch transitions.

## Gate 4 — Live Pi with controlled overflow injection [P0; small real-model calls]

**Prerequisite:** A development-only fault-injection hook is *not currently part of the feature*. Implement it locally or in a temporary test-only overlay before this gate; remove it from the release diff. It should simulate a context-overflow result **before** sending batches above a small call count to the inference provider, and let smaller batches use the actual provider. It must not mutate original tool results or production session history.

- [ ] Isolate session storage and loaded pruner extension. Running `pi-local -e "$PWD"` while a globally installed second copy is loaded may register duplicate tools; ensure exactly one copy is active.
- [ ] Preserve or isolate `~/.pi/agent/context-prune/settings.json` (session-directory isolation alone does **not** isolate global settings). An isolated `PI_CODING_AGENT_DIR` also isolates model/credential discovery; supply only the necessary test configuration/credentials using supported safe mechanisms.
- [ ] Set `/pruner on`, `/pruner batching agent-message`, `/pruner prune-on on-demand`.
- [ ] Generate and verify **exactly eight completed harmless tool calls**, with sufficient raw output that a short summary is smaller.
- [ ] Trigger `/pruner now`, injecting overflow on batches of more than two calls.
- [ ] Verify 7 total attempts (3 simulated rejections, 4 actual provider successes), 4 persisted leaf summaries, 8 unique indexed IDs, no lost outputs, and chronological order.
- [ ] Confirm visible progress: running → splitting oversized batch → smaller-batch summarization → completed; no error notification for simulated recoverable overflow.
- [ ] Run `/pruner now` again; expect nothing pending and no additional summarizer requests.
- [ ] Restart the disposable session and repeat; expect no duplicate index/summary entries.
- [ ] Repeat with `/pruner prune-on agentic-auto` and an actual `context_prune` tool call to exercise the runtime delivery path.
- [ ] Disable the injection and repeat a small normal batch; expect exactly one call, no split UI.
- [ ] Remove the development hook and confirm the clean feature diff still passes Gate 1.

**Optional command pattern** (requires model configuration available to the isolated agent directory):

```bash
mkdir -p "$TEST_ROOT/agent" "$TEST_ROOT/sessions"
PI_CODING_AGENT_DIR="$TEST_ROOT/agent" \
  PI_PRUNER_TEST_OVERFLOW_MAX_CALLS=2 \
  pi-local -e "$PWD" --session-dir "$TEST_ROOT/sessions"
```

The environment variable above is **proposed test instrumentation**, not a supported setting in the committed extension. Avoid using it until its temporary hook exists.

## Gate 5 — Real provider context-overflow acceptance [P1; deliberate opt-in]

**Do not start with the original 417-call replay**: the full attempt will still be sent first and may exceed 262,144 tokens, consume substantial memory/time, and incur token usage on some providers. This test is optional until the inexpensive gates pass.

- [ ] Prefer a small-context provider/model or a local inference backend configured with a deliberately small context window so a modest fixture triggers a **genuine** overflow.
- [ ] Capture the exact provider error shape (response `stopReason/errorMessage` or thrown exception) with secrets redacted.
- [ ] Verify the pruner recognizes it, suppresses its own recoverable notification, recursively succeeds, and persists ordered results.
- [ ] If provider adapter or Pi core independently displays an error, distinguish that from the pruner's own `ctx.ui.notify`; document any unavoidable external logging.
- [ ] Only with explicit consent to resource use, copy `~/workspace/pi-pruner-debug/failed-session.jsonl` into a disposable session directory and replay there. **Never continue or edit the original captured session.**
- [ ] Verify the expected 417 historical calls appear only in the copied session and that their eventual leaf index/summary records are in original order.
- [ ] Track input/output tokens and summarizer calls including failed attempts; record unusual retries, timeouts, or provider-specific errors.
- [ ] Test at least one local and one hosted provider **if already available**. Do not imply every model has been tested; unsupported providers need honest status.

**Pass:** At least one genuine inference-backend rejection is handled as intended; any provider-specific limitations are explicitly documented.

## Gate 6 — Cross-mode and lifecycle regression matrix [P1]

| Dimension | Scenarios |
|---|---|
| Enabled from session start versus enabled mid-session | Both invoke the same fallback; no special activation flag |
| Batching | `agent-message` and `turn` |
| Trigger | `on-demand`, `agentic-auto`, `every-turn`, `agent-message`, and `on-context-tag` where the tool is installed |
| Summary delivery | Runtime steer and session custom-message persistence |
| Session lifecycle | New session, repeated prompts, restart/continue, branch switch |
| Response patterns | 1 successful request, one split, nested splits, single-call terminal overflow |
| Error modes | Provider result error, exception, auth/rate/network, aborted stream, persistence failure |
| Provider diversity | Mocked models of varied context sizes; available local/hosted backends |
| Data shape | Large arguments, giant results, repeated tool names, odd counts, single turn with many calls, multiple assistant turns |

All combinations need not be exhaustively crossed. Prioritize paths that differ in persistence and event behavior, and capture which cases were actually executed.

## Gate 7 — Release decision, evidence, and cleanup [P0]

- [ ] The full local check suite passes at the final feature-branch SHA.
- [ ] The successful first-attempt path still uses **exactly one** summarizer request.
- [ ] Simulated overflow is silent when recovered; non-overflow errors remain visible.
- [ ] Persisted tool-call IDs have no gaps, overlap, or reordering, including after partial failure and restart.
- [ ] Frontier never crosses a failed or unprocessed range.
- [ ] All pruned outputs are recoverable through `context_tree_query`.
- [ ] `context_prune` and `/pruner now` have accurate progress/status and no misleading completion message after partial failure.
- [ ] Abort-after-first-success behavior is measured and either corrected or explicitly approved as a known limitation.
- [ ] Mixed-success original batches and usage/cost accounting are measured and documented.
- [ ] No temporary fault-injection hook, credential, private session, or debug output is committed.
- [ ] No GitHub Actions workflows have been created, edited, enabled, or run.
- [ ] Record test commands, versions, SHA, passed/failed/skipped cases, and a short release recommendation.

### Test report template

```text
Branch / SHA:
Node / npm / Pi / selected model:
Date:
Gate 0 — isolation:                  PASS / FAIL
Gate 1 — build + suite:              PASS / FAIL
Gate 2 — helper tests:               PASS / FAIL
Gate 3 — mocked Pi integration:      PASS / FAIL
Gate 4 — controlled live Pi:         PASS / FAIL / NOT RUN
Gate 5 — genuine provider overflow:  PASS / FAIL / NOT RUN
Gate 6 — mode/lifecycle matrix:      PASS / FAIL / PARTIAL
Chronology and frontier checks:      PASS / FAIL
Raw-output recovery:                PASS / FAIL
Abort / partial-persistence finding:
Unresolved issues / reproduction:
Final decision:                     READY / FIX FIRST / CONDITIONAL
```

## Execution order

**First pass:** Gates 0 → 1 → 2 → 3. Fix any reproducible failures before touching a live model.

**Second pass:** Gate 4 with a disposable session and bounded real-model requests. Then Gate 6 to check relevant modes and lifecycle paths.

**Final acceptance:** Gate 5 with a real overflow only when resources and credentials are ready; finish Gate 7 and record unresolved limitations.

**Do not merge, publish, tag, or run automation as part of following this plan.**
