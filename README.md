# jev-compaction

Context compaction for [Hermes](https://github.com/NousResearch/hermes-agent) sessions
that **never summarises**. Every tool call is scored by
[TypeSafe](https://typesafe.ai)'s Jev model, and only the calls and results that
are no longer needed are removed or truncated. Everything kept stays verbatim.

Adapted from [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
(MIT), with two additions described below.

## The problem with summarising

Most context compaction asks a model to summarise older turns. A summary is
lossy: a file path, an exact error message, a constraint, or a command can
disappear even when it still matters. Worse, a reader of the summary cannot tell
what was dropped.

This tool does not rewrite anything. It deletes tool calls and tool results that
Jev judges to be stale, and it shows Jev the whole conversation while deciding.
User and assistant text is never removed or shortened.

## How it works

1. Every tool call is paired with its result. Calls in the first message and in
   the newest `--preserve` messages are pinned and never touched.
2. The state sent to Jev is the whole conversation so far, oldest first, with
   each result replaced by a short note. Tool inputs and texts are included;
   nothing is summarised.
3. For every non-pinned call Jev answers two `noul` questions — the probability
   that the answer is yes:
   - `keepCall` — does it still matter *that* this call was made?
   - `keepResult` — are the result's contents still needed, and would re-running
     the tool not deliver them just as well?
4. Against the threshold:
   - `keepResult >= threshold` → keep the call and the result;
   - else `keepCall >= threshold` → keep the call, truncate the result to its
     first `--truncate` characters plus a note;
   - else → drop call and result together.
5. The **original** messages are then pruned in place. Nothing is rebuilt: a
   dropped call's entry is removed from the `tool_calls` array, and its result
   message is dropped. All other fields — ids, `reasoning_content`, metadata —
   survive untouched.

## Install

```sh
git clone https://github.com/picaye/jev-compaction.git
cd jev-compaction
./setup.sh          # clones and builds the upstream library
```

`setup.sh` needs Node 18+ and network access. It builds
`tamaratran/fast-jev-compaction` from source, because the npm package named in
that project's README is **not published to the registry** —
`npm install fast-jev-compaction` returns 404.

Then export your key:

```sh
export TYPESAFE_API_KEY=...      # https://console.typesafe.ai/
```

The adapter reads the key from the environment only. It is never written to a
file by this tool.

## Usage

Sessions live in `~/.hermes/state.db` (tables `sessions` and `messages`). The
JSON files under `~/.hermes/sessions/` are a **legacy mirror that ends in May
2026** — modern, long sessions are only in the database.

```sh
# find a session
node hermes-compact.mjs --find steuerberatung

# dry run by session id — measures, writes nothing
node hermes-compact.mjs --session 20260914_211401_391d8abe

# write the compacted transcript
node hermes-compact.mjs --session 20260914_211401_391d8abe --out out/compacted.json

# a legacy JSON file still works
node hermes-compact.mjs ~/.hermes/sessions/session_<id>.json
```

Options:

- `--session <id>` — read from the state database (default `~/.hermes/state.db`)
- `--db <path>` — another database
- `--find <text>` — list matching sessions with their tool-call counts
- `--active-only` — only rows flagged `active = 1`, i.e. the live context
- `--out <file>` — write the compacted session (default: dry run, nothing written)
- `--threshold <n>` — keep probability required to keep (default `0.5`)
- `--preserve <n>` — newest messages never touched (default `6`)
- `--truncate <n>` — characters retained from a dropped result (default `300`)
- `--goal <text>` — ongoing task description (default: derived from the session)
- `--dump <file>` — write every decision with its `keepCall`/`keepResult`

The database is only ever read. Nothing is written back to it; output is a JSON
file.

## What the report tells you

```
Urteile je Tool-Call:
  behalten          1
  Ergebnis gekürzt  10
  Call entfernt     1117
  davon gerettet    7 (zustandsändernd, Politik schlägt Urteil)

Nachrichten  : 2242 -> 34
Reduktion    : 97.3 %

Konsistenz   : verwaiste Ergebnisse 0, verwaiste Calls 0
Integrität   : User-/Assistant-Texte unverändert = true
Abdeckung    : 1128 von 1129 Tool-Calls beurteilt
```

`Konsistenz` and `Integrität` are the real test. A compaction that saves context
while tearing calls from their results, or rewriting text, is broken regardless
of its reduction ratio. Both must be `0` and `true`.

## Guarantees

- **No text is ever rewritten.** User and assistant messages come out byte-identical.
- **No orphaned entries.** A result never outlives its call; a call is never left without its result.
- **State-changing calls are never dropped.** See below.
- **The first message and the newest `--preserve` messages are never touched.**

## Policy beats judgement: `PROTECTED_TOOLS`

This is the most important lesson from building this, and it was found by
checking the *written file* rather than the in-memory result.

On a session with 1,128 tool calls the output was structurally valid — two
calls, two results, no orphans — and yet **all nine state-changing calls**
(`patch`, `write_file`) were gone. The transcript no longer recorded that
anything had been written.

Jev does not judge consistently across sessions: in one session `write_file`
scored `keepResult` **1.00** and stayed; in another it was dropped. No guarantee
can rest on that.

So the decision lives in code:

```js
const PROTECTED_TOOLS = new Set(['write_file','patch','skill_manage','memory',
  'cronjob_manage','todo','todo_list','process_manage']);
```

If Jev wants such a call gone, it is **rescued**: the call stays and only its
result is truncated. That is the right split, because the call carries its
arguments — for `write_file`, the content written. You lose the acknowledgement,
not the fact.

Cost on that session: reduction 98.7% → 97.3%, 14 → 34 messages, 7 calls
rescued. Two points of context for the provability of what the session did.

## Windowing for long sessions

The upstream library sends the state of the **whole** conversation with every
request, and throws when it cannot be fitted under `maxStateTokens`:

```
history too large for Jev (~31976 tokens after truncation, limit 25000)
```

For a session of 2,242 messages with 1,129 tool calls that is the normal case,
not the exception: Jev's hard request limit is 32k and the library's most
aggressive fitting stage already lands there. Raising `maxStateTokens` does not
help.

The adapter catches exactly this error and splits the transcript into windows
(2, 4, 8 … until each fits), compacting each separately. Judgements are per call
and local — the same decision Jev makes for a call when it sees it.

Two pitfalls when windowing:

- **Short ids collide.** Every request restarts at `t1, t2, …`, so verdicts from
  several windows must be keyed by the globally unique `tool_use_id`, or the
  windows overwrite each other.
- The last window carries the live end of the session, so it keeps the full
  `--preserve` count; every other window runs with `--preserve 1`, having no
  newest edge of its own.

## Two ways a real transcript lies

Both of these were found by running against a real 3,845-message session, and
both produced a wrong result before they were fixed. Neither is a Jev problem.

### 1. The database holds several generations of the same conversation

Loading every row in `id` order gave a conversation that never happened. On that
session: **1,852 tool results for only 1,127 distinct call ids** (682 ids twice,
22 three times), and of 3,818 messages **only 206 were flagged `active = 1`** —
all of them at the very end. Retries and rewinds store the same call again.

The library pairs one call with one result, so the extra copies became orphans:
the first attempt reported **613 orphaned results** and judged only 61% of the
calls. The fix is to keep each `tool_call_id` and each call exactly once, first
occurrence, and to report how many rows that skipped:

```
Aus der DB   : 3827 Zeilen gelesen, 1454 Doppel (Wiederholungen) entfernt
```

### 2. The last window is the live end, not old history

Windowed mode originally ran every window with `--preserve 1`. For every window
but the last that is right — a window has no newest edge to protect. The last
window contains the live end of the session, so flattening it means treating the
newest messages as old history.

That cost one result from an `active = 1` message: its call survived, its result
did not. The last window now keeps the full `--preserve` count, and the
invariant is additionally enforced after the fact — a result whose call is gone
is removed, and the report says so — instead of trusting the library's
ordering-based pairing:

```
Abgleich     : 0 hängengebliebene Ergebnisse entfernt (Quelle bringt 1 Call(s) ohne Ergebnis mit)
Konsistenz   : verwaiste Ergebnisse 0, verwaiste Calls 1 (wie in der Quelle)
```

A call without a result is not damage: that is how it stands in the source
(an interrupted turn), and it is reported as inherited rather than as a fault.

## Measured results

Reduction on real Hermes sessions, all with `Konsistenz` clean and
`Integrität = true`:

- **steuerberatung.ch working session** — 2,755 messages, 1,143 calls: 2,755 → 1,268 messages, 4,127,809 → 1,321,047 characters, **68.0%**; all 139 state-changing calls preserved (`patch` 76, `write_file` 36, `memory` 17, `skill_manage` 10); every emitted text byte-identical to the source
- browser-automation session — 1,128 calls, 2,242 → 17 messages, 921,326 → 14,379 characters, **98.4%**
- mixed session — 116 calls, 236 → 11 messages, **96.5%**
- substantive session — 54 calls, 82 → 11 messages, **91.6%**
- small session — 53 calls, 97 → 12 messages, 277,847 → 67,053 characters, **75.9%**

### The ratio alone means nothing

Across all sessions the absolute probabilities are **low**: median `keepResult`
0.05–0.13, only 0.1–5.6% above 0.5. That looks like a fault and is not one. Agent
sessions consist mostly of calls whose results can be re-obtained at will —
reads, searches, executions. For compaction those are exactly the dispensable
ones.

What matters is the **ranking**, and it is clear:

- `write_file`, `skill_manage` — **1.00**
- `todo` — 0.57
- `search_files` — 0.21
- `patch` — 0.19
- `read_file` — 0.13–0.18
- `terminal` — 0.08–0.13
- `browser_type`, `browser_click` — 0.05
- `process` (polling) — 0.04

That is the right distinction: that a file was written must survive; its contents
need not. But the ranking is per session and is not a guarantee — hence the
protection policy above.

**The threshold is the lever.** With a median around 0.1, a threshold of 0.5
decides on very low probabilities. Lower it if you need to keep more. The
upstream project warns explicitly that a probability is not proof that a result
is safe to delete.

## Limits

- Only tool calls and results are candidates. Text is never removed or shortened
  in the output (it is only abridged in the state Jev sees).
- A probability is not proof. The model can always re-run a tool.
- Token sizes are estimates from character counts, not a tokeniser.
- The full state is resent with every request. A history near the state ceiling
  costs one request per handful of questions; the 1,128-call session took 12
  requests across 2 windows.
- Judgement quality depends on context. Better `--goal` text did not move the
  numbers on a session that genuinely consisted of dispensable calls.

## Attribution

Built on [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
by Allie Laabs (MIT). That project provides the algorithm, the Jev client, the
state-fitting stages, and the message model. This repository provides a Hermes
adapter — transcript mapping, in-place pruning of original messages, windowing,
and the state-changing-call policy — plus documentation of what was measured.

The upstream source is **not vendored here**. `setup.sh` clones and builds it, so
upstream stays the single source of truth and cannot go stale in a fork.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
