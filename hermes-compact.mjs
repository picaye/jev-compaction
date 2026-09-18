#!/usr/bin/env node
/**
 * fast-jev-compaction, adaptiert auf Hermes-Sitzungen.
 *
 * Warum: Hermes kompaktiert lange Sitzungen, indem ein Modell ältere Turns
 * zusammenfasst. Eine Zusammenfassung ist verlustbehaftet — ein Dateipfad, ein
 * exakter Fehlertext oder ein Constraint kann verschwinden, auch wenn er später
 * gebraucht wird. Dieser Adapter fasst nichts zusammen. Er lässt Jev jeden
 * Tool-Call bewerten und entfernt oder kürzt ausschliesslich das, was nicht mehr
 * gebraucht wird. Alles Behaltene bleibt wortgetreu.
 *
 * Aufruf:
 *   node hermes-compact.mjs <session.json> [--out <datei>] [--threshold 0.5]
 *
 * Ohne --out wird nichts geschrieben (Probelauf).
 *
 * Anpassung gegenüber der Vorlage: Die Bibliothek schickt den State der GANZEN
 * Unterhaltung mit jeder Anfrage und wirft, wenn er sich nicht unter
 * `maxStateTokens` bringen lässt ("history too large for Jev"). Bei sehr langen
 * Sitzungen ist das der Normalfall, nicht die Ausnahme. Deshalb zerlegt dieser
 * Adapter den Verlauf in Fenster und kompaktiert jedes separat. Die Urteile sind
 * pro Call lokal — dieselbe Entscheidung, die Jev für einen Call trifft, wenn er
 * ihn sieht.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const REPO = new URL('./src-repo/dist/index.js', import.meta.url).href;

function parseArgs(argv) {
  const opts = {
    session: null,
    out: null,
    threshold: 0.5,
    preserveRecentMessages: 6,
    truncateHeadChars: 300,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--goal') opts.goal = argv[++i];
    else if (a === '--dump') opts.dump = argv[++i];
    else if (a === '--threshold') opts.threshold = Number(argv[++i]);
    else if (a === '--preserve') opts.preserveRecentMessages = Number(argv[++i]);
    else if (a === '--truncate') opts.truncateHeadChars = Number(argv[++i]);
    else if (!opts.session) opts.session = a;
  }
  return opts;
}

function safeParse(s) {
  if (typeof s !== 'string') return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return { raw: s };
  }
}

/**
 * Hermes-Nachrichten -> Bibliotheks-Nachrichten.
 * Gibt zusätzlich die Rückabbildung Bibliotheks-Index -> Hermes-Index zurück,
 * damit später die ORIGINAL-Nachrichten beschnitten werden können.
 */
function toLibrary(messages) {
  const lib = [];
  const libToHermes = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    libToHermes.push(i);

    if (m.role === 'tool') {
      // Hermes führt Tool-Ergebnisse als eigene Nachricht; die Bibliothek
      // erwartet sie als toolResults einer User-Nachricht.
      lib.push({
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: m.tool_call_id, text: String(m.content ?? '') }],
      });
    } else if (m.role === 'assistant') {
      const toolUses = (m.tool_calls ?? []).map((tc) => ({
        tool_use_id: tc.id ?? tc.call_id,
        tool: tc.function?.name ?? tc.name ?? 'unknown',
        input: safeParse(tc.function?.arguments),
      }));
      lib.push({ role: 'assistant', text: String(m.content ?? ''), toolUses });
    } else {
      lib.push({ role: 'user', text: String(m.content ?? ''), toolUses: [] });
    }
  }
  return { lib, libToHermes };
}

/**
 * Werkzeuge, deren Aufruf nie entfallen darf.
 *
 * Jevs Urteil hängt am Sitzungskontext und ist nicht über Sitzungen hinweg
 * stabil: `write_file` kam in einer Sitzung auf keepResult 1.00 und wurde in
 * einer anderen zusammen mit allen übrigen zustandsändernden Aufrufen
 * verworfen. Danach weiss der Verlauf nicht mehr, dass überhaupt geschrieben
 * wurde — die Information, die eine fortgesetzte Sitzung am dringendsten
 * braucht.
 *
 * Der Aufruf trägt seine Argumente (bei write_file den geschriebenen Inhalt),
 * also bleibt beim Behalten des Calls der Inhalt erhalten, während das Ergebnis
 * gekürzt werden darf. Diese Entscheidung gehört in den Code, nicht ins Modell.
 */
const PROTECTED_TOOLS = new Set([
  'write_file',
  'patch',
  'skill_manage',
  'memory',
  'cronjob_manage',
  'todo',
  'todo_list',
  'process_manage',
]);

const isTooLarge = (err) =>
  /too large|maxStateTokens|cannot be fitted/i.test(String(err?.message ?? ''));

/**
 * Das Ziel der Gesamtsitzung.
 *
 * Ohne das urteilt Jev in einem Fenster über Tool-Calls, ohne die Aufgabe zu
 * kennen — und verwirft dann fast alles. Die Bibliothek leitet das Ziel aus den
 * letzten User-Prompts des jeweiligen Eingabeausschnitts ab; in langen
 * Agentensitzungen, die aus einer einzigen User-Nachricht bestehen, ist das im
 * Fenster nichts. Deshalb wird das Ziel hier aus der ganzen Sitzung gebildet und
 * jedem Fenster mitgegeben.
 */
function goalFor(messages, explicit) {
  if (explicit) return explicit;
  const user = messages.find((m) => m.role === 'user' && String(m.content ?? '').trim());
  const head = user ? String(user.content).trim() : '';

  // Die LETZTE Assistant-Textnachricht sagt, was die Sitzung erreicht hat. Die
  // erste ist bei langen Sitzungen ein Zwischenschritt und täuscht Jev über die
  // Aufgabe. Ohne Ergebnis-Kontext kann Jev nicht entscheiden, welche Calls
  // dorthin geführt haben — er verwirft dann gleichförmig alles.
  const lastText = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && String(m.content ?? '').trim().length > 80);
  const tail = lastText ? String(lastText.content).trim() : '';

  const combined = [head, tail].filter(Boolean).join('\n\n--- Ergebnis der Sitzung ---\n\n');
  return combined.slice(0, 4000);
}

/**
 * Sammelt Jevs Urteile als Map tool_use_id -> action.
 *
 * Erst der ganze Verlauf; passt er nicht in die State-Grenze, wird er in immer
 * mehr Fenster zerlegt, bis jedes einzelne passt. Innerhalb einer Anfrage
 * vergibt die Bibliothek die kurzen IDs (t1, t2, …) neu, deshalb werden die
 * Urteile über die global eindeutige tool_use_id geführt.
 */
async function decideAll(lib, libOpts, compactMessages, collectToolCalls, debug) {
  const actions = new Map();
  const detail = [];
  const stats = { requests: 0, windows: 1, callsJudged: 0 };

  const absorb = (result, slice, preserve) => {
    const byShortId = new Map(
      collectToolCalls(slice, preserve).map((c) => [c.id, c.tool_use_id]),
    );
    for (const d of result.decisions ?? []) {
      const toolUseId = byShortId.get(d.id) ?? d.id;
      actions.set(toolUseId, d.action);
      detail.push({
        tool_use_id: toolUseId,
        tool: d.tool,
        action: d.action,
        reason: d.reason,
        keepCall: d.keepCall,
        keepResult: d.keepResult,
      });
      stats.callsJudged++;
    }
    stats.requests += result.stats?.requests ?? 1;
  };

  try {
    absorb(await compactMessages(lib, libOpts), lib, libOpts.preserveRecentMessages);
    return { actions, detail, stats };
  } catch (err) {
    if (!isTooLarge(err)) throw err;
    debug('  Verlauf passt nicht in eine Anfrage — Fensterung nötig.');
  }

  for (let windows = 2; windows <= 64; windows *= 2) {
    const size = Math.ceil(lib.length / windows);
    const slices = [];
    for (let i = 0; i < lib.length; i += size) slices.push(lib.slice(i, i + size));

    // Ein Fenster hat keinen "neuesten" Rand, der geschützt werden müsste; die
    // Fixierung des jeweils ersten Fenstereintrags bleibt bestehen.
    const perWindow = { ...libOpts, preserveRecentMessages: 1 };
    const results = [];
    let fits = true;
    for (const slice of slices) {
      try {
        results.push(await compactMessages(slice, perWindow));
      } catch (err) {
        if (!isTooLarge(err)) throw err;
        fits = false;
        break;
      }
    }
    if (!fits) {
      debug(`  ${slices.length} Fenster reichen nicht — verdopple.`);
      continue;
    }

    results.forEach((r, k) => absorb(r, slices[k], perWindow.preserveRecentMessages));
    stats.windows = slices.length;
    return { actions, detail, stats };
  }
  throw new Error('Verlauf passt auch gefenstert nicht in die State-Grenze.');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.session) {
    console.error('Aufruf: node hermes-compact.mjs <session.json> [--out <datei>]');
    process.exit(2);
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('TYPESAFE_API_KEY fehlt.');
    process.exit(2);
  }

  const { compactMessages, collectToolCalls } = await import(REPO);

  const session = JSON.parse(readFileSync(opts.session, 'utf8'));
  const messages = session.messages ?? [];
  const { lib, libToHermes } = toLibrary(messages);

  const before = JSON.stringify(messages).length;
  console.log(`Sitzung      : ${basename(opts.session)}`);
  console.log(`Nachrichten  : ${messages.length}`);
  console.log(`Zeichen vor  : ${before.toLocaleString('de-CH')}`);
  console.log(`Schwelle     : keepResult/keepCall >= ${opts.threshold}`);
  console.log('');

  const goal = goalFor(messages, opts.goal);
  const libOpts = {
    goal,
    keepThreshold: opts.threshold,
    preserveRecentMessages: opts.preserveRecentMessages,
    truncateHeadChars: opts.truncateHeadChars,
  };
  console.log(`Ziel         : ${goal ? `${goal.length} Zeichen mitgegeben` : 'keines gefunden'}`);

  const { actions: actionByToolUseId, detail: callDetail, stats: runStats } = await decideAll(
    lib,
    libOpts,
    compactMessages,
    collectToolCalls,
    (m) => console.log(m),
  );

  // Hermes-Indizes über den Gesamtverlauf auflösen.
  const fullCalls = collectToolCalls(lib, opts.preserveRecentMessages);
  const callByToolUseId = new Map(fullCalls.map((c) => [c.tool_use_id, c]));

  const removed = new Set();
  const truncated = new Map();
  const droppedCallIds = new Set();
  const byAction = { keep: 0, drop_result: 0, drop_call: 0, unknown: 0 };

  const truncateResult = (hResult) => {
    const original = String(messages[hResult].content ?? '');
    truncated.set(
      hResult,
      original.slice(0, opts.truncateHeadChars) +
        `\n[… ${(original.length - opts.truncateHeadChars).toLocaleString('de-CH')} Zeichen von Jev als nicht mehr nötig verworfen]`,
    );
  };

  let rescued = 0;
  for (const [toolUseId, action] of actionByToolUseId) {
    const call = callByToolUseId.get(toolUseId);
    if (!call) {
      byAction.unknown++;
      continue;
    }
    if (action === 'keep') {
      byAction.keep++;
      continue;
    }
    const hResult = libToHermes[call.resultIndex];
    if (hResult === undefined) continue;

    // Politik schlägt Urteil: ein zustandsändernder Aufruf bleibt im Verlauf,
    // auch wenn Jev ihn verwerfen wollte. Sein Ergebnis darf gekürzt werden.
    if (action === 'drop_call' && PROTECTED_TOOLS.has(call.tool)) {
      rescued++;
      byAction.drop_result++;
      truncateResult(hResult);
      continue;
    }

    if (action === 'drop_call') {
      byAction.drop_call++;
      removed.add(hResult);
      droppedCallIds.add(toolUseId);
    } else if (action === 'drop_result') {
      byAction.drop_result++;
      truncateResult(hResult);
    }
  }

  // Original-Nachrichten beschneiden — nichts umschreiben, nur entfernen/kürzen.
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    if (removed.has(i)) continue;
    const m = { ...messages[i] };
    if (truncated.has(i)) m.content = truncated.get(i);

    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const kept = m.tool_calls.filter((tc) => !droppedCallIds.has(tc.id ?? tc.call_id));
      if (kept.length !== m.tool_calls.length) {
        // Eine Assistant-Nachricht ohne Text und ohne Call trägt nichts mehr.
        if (kept.length === 0 && !String(m.content ?? '').trim()) continue;
        m.tool_calls = kept;
      }
    }
    out.push(m);
  }

  // Nachkontrolle: kein Ergebnis ohne zugehörigen Call, kein Call ohne Ergebnis.
  const callIds = new Set();
  const resultIds = new Set();
  for (const m of out) {
    if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) callIds.add(tc.id ?? tc.call_id);
    if (m.role === 'tool') resultIds.add(m.tool_call_id);
  }
  const orphanResults = [...resultIds].filter((id) => !callIds.has(id));
  const orphanCalls = [...callIds].filter((id) => !resultIds.has(id));

  const after = JSON.stringify(out).length;
  console.log('Urteile je Tool-Call:');
  console.log(`  behalten          ${byAction.keep}`);
  console.log(`  Ergebnis gekürzt  ${byAction.drop_result}`);
  console.log(`  Call entfernt     ${byAction.drop_call}`);
  console.log(`  davon gerettet    ${rescued} (zustandsändernd, Politik schlägt Urteil)`);
  console.log(`  ohne Zuordnung    ${byAction.unknown}`);
  console.log('');
  console.log(`Nachrichten  : ${messages.length} -> ${out.length}`);
  console.log(`Zeichen      : ${before.toLocaleString('de-CH')} -> ${after.toLocaleString('de-CH')}`);
  console.log(`Reduktion    : ${(100 * (1 - after / before)).toFixed(1)} %`);
  console.log('');
  console.log(`Konsistenz   : verwaiste Ergebnisse ${orphanResults.length}, verwaiste Calls ${orphanCalls.length}`);
  console.log(`Integrität   : User-/Assistant-Texte unverändert = ${textUnchanged(messages, out)}`);
  console.log(`Abdeckung    : ${actionByToolUseId.size} von ${fullCalls.length} Tool-Calls beurteilt`);
  console.log(`Aufwand      : ${runStats.requests} Anfrage(n) an Jev, ${runStats.windows} Fenster`);

  if (opts.dump) {
    writeFileSync(opts.dump, JSON.stringify(callDetail, null, 2), 'utf8');
    console.log(`Urteile      : ${opts.dump} (${callDetail.length} Einträge mit Wahrscheinlichkeiten)`);
  }

  if (opts.out) {
    const payload = {
      ...session,
      messages: out,
      message_count: out.length,
      compacted_at: new Date().toISOString(),
      compaction: {
        method: 'fast-jev-compaction (Jev jev-latest), gefenstert',
        keepThreshold: opts.threshold,
        preserveRecentMessages: opts.preserveRecentMessages,
        charsBefore: before,
        charsAfter: after,
        reduction: Number((1 - after / before).toFixed(4)),
        callsKept: byAction.keep,
        resultsTruncated: byAction.drop_result,
        callsDropped: byAction.drop_call,
        toolCallsTotal: fullCalls.length,
      },
    };
    writeFileSync(opts.out, JSON.stringify(payload), 'utf8');
    console.log(`\nGeschrieben   : ${opts.out}`);
  } else {
    console.log('\nProbelauf — nichts geschrieben (--out fehlt).');
  }
}

/** Nachweis, dass kein User-/Assistant-Text angetastet wurde. */
function textUnchanged(before, after) {
  const texts = (msgs) =>
    msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => String(m.content ?? ''))
      .filter((t) => t.trim() !== '')
      .join('\u0000');
  return texts(before) === texts(after);
}

main().catch((err) => {
  console.error('FEHLER:', err?.message ?? err);
  process.exit(1);
});
