---
name: jev-compaction
license: MIT
description: "Use when compacting Hermes context: Jev scores tool calls."
---

# Jev-Kompaktierung für Hermes-Sitzungen

## Warum nicht zusammenfassen

Hermes kompaktiert lange Sitzungen, indem ein Modell ältere Turns zusammenfasst.
Eine Zusammenfassung ist verlustbehaftet: ein Dateipfad, ein exakter Fehlertext,
ein Constraint oder ein Befehl kann verschwinden, auch wenn er später gebraucht
wird. Wer die Zusammenfassung liest, weiss nicht, was fehlt.

Dieses Verfahren fasst **nichts** zusammen. Es lässt Jev jeden Tool-Call
bewerten und entfernt oder kürzt ausschliesslich, was nicht mehr gebraucht wird.
Alles Behaltene bleibt wortgetreu, User- und Assistant-Texte werden nie
angetastet.

## Aufruf

```bash
cd ~/.hermes/tools/jev-compaction
export TYPESAFE_API_KEY="$(grep '^TYPESAFE_API_KEY=' ~/.hermes/.env | head -1 | cut -d= -f2-)"
node hermes-compact.mjs ~/.hermes/sessions/<session>.json            # Probelauf
node hermes-compact.mjs ~/.hermes/sessions/<session>.json --out out/<name>.json
```

Optionen: `--threshold` (Standard 0.5), `--preserve` (neueste unberührte
Nachrichten, Standard 6), `--truncate` (Zeichen, die von einem verworfenen
Ergebnis erhalten bleiben, Standard 300). Ohne `--out` wird nichts geschrieben.

Der Probelauf schreibt nie — erst messen, dann entscheiden.

## Was der Bericht zeigt

- Urteile je Tool-Call: behalten / Ergebnis gekürzt / Call entfernt
- Nachrichten und Zeichen vor und nach der Kompaktierung
- State-Tokens, Anzahl Anfragen, benötigte Anpassungsstufe
- **Konsistenz**: verwaiste Ergebnisse und verwaiste Calls. Müssen beide 0 sein.
- **Integrität**: ob alle User-/Assistant-Texte unverändert sind. Muss `true` sein.

Die letzten zwei Zeilen sind der eigentliche Test. Eine Kompaktierung, die
Kontext spart, aber Calls und Ergebnisse auseinanderreisst oder Text umschreibt,
ist kaputt — unabhängig von der Reduktionsquote.

## Zwei Fragen pro Call

Jev bekommt pro nicht fixiertem Call zwei `noul`-Fragen (Wahrscheinlichkeit für
Ja):

1. **keepCall** — ist es noch wichtig, dass dieser Call gemacht wurde?
2. **keepResult** — werden die Inhalte des Ergebnisses noch gebraucht, und würde
ein erneuter Lauf des Tools sie nicht ebenso liefern?

Daraus folgt die Entscheidung gegen die Schwelle:

- `keepResult >= Schwelle` → Call und Ergebnis bleiben
- sonst `keepCall >= Schwelle` → Call bleibt, Ergebnis auf Kopf + Hinweis gekürzt
- sonst → Call und Ergebnis entfallen

Der State, den Jev sieht, ist die **ganze** bisherige Unterhaltung (älteste
zuerst), Ergebnisse durch kurze Notizen ersetzt. Das Modell urteilt also im
Kontext der Aufgabe, nicht über einen Auszug.

## Grenzen — offen benennen

- **Nur Tool-Calls und -Ergebnisse sind Kandidaten.** Text wird im Ergebnis nie
  entfernt oder gekürzt (nur im State, den Jev sieht).
- **Eine Wahrscheinlichkeit ist kein Beweis.** Dass ein Ergebnis entbehrlich
  scheint, heisst nicht, dass das Löschen sicher ist. Das Modell kann ein Tool
  erneut aufrufen.
- **Token-Grössen sind Schätzungen** aus Zeichenzahlen, kein Tokenizer.
- **Der State wird mit jeder Anfrage erneut gesendet.** Bei sehr langen
  Sitzungen kostet das eine Anfrage pro Handvoll Fragen.
- **Harte Fixierung.** Die erste Nachricht und die neuesten
  `preserveRecentMessages` werden nie angefasst.

## Gemessene Ergebnisse

| Sitzung | Tool-Calls | Nachrichten | Zeichen | Reduktion | Konsistenz |
| --- | --- | --- | --- | --- | --- |
| Browser-Automatik | 1128 | 2242 → 17 | 921'326 → 14'379 | 98.4 % | 0 verwaiste |
| gemischt, substanziell | 116 | 236 → 11 | — | 96.5 % | 0 verwaiste |
| substanziell | 54 | 82 → 11 | — | 91.6 % | 0 verwaiste |
| klein | 53 | 97 → 12 | 277'847 → 67'053 | 75.9 % | 0 verwaiste |

In allen Läufen: `verwaiste = 0` und `Integrität = true`.

### Die Quote allein sagt nichts

Auf allen Sitzungen sind die absoluten Wahrscheinlichkeiten **niedrig**: Median
`keepResult` 0.05–0.13, nur 0.1–5.6 % über 0.5. Das sieht nach einem Fehler aus,
ist aber keiner. Agentensitzungen bestehen überwiegend aus Aufrufen, deren
Ergebnis beliebig oft neu beschaffbar ist — Lesen, Suchen, Ausführen. Für die
Kompaktierung ist genau das entbehrlich.

Entscheidend ist deshalb nicht der Median, sondern die **Rangfolge**, und die ist
deutlich:

| Tool | mittleres `keepResult` |
| --- | --- |
| `write_file`, `skill_manage` | **1.00** |
| `todo` | 0.57 |
| `patch` | 0.19 |
| `search_files` | 0.21 |
| `read_file` | 0.13–0.18 |
| `terminal` | 0.08–0.13 |
| `browser_type`, `browser_click` | 0.05 |
| `process` (Polling) | 0.04 |

Jev behält also die zustandsändernden Aufrufe mit 1.00 und verwirft die
nachlesbaren. Das ist die richtige Unterscheidung: dass eine Datei geschrieben
wurde, muss im Verlauf bleiben; ihr Inhalt nicht.

**Die Schwelle ist der Hebel.** Bei `keepResult`-Median um 0.1 entscheidet die
0.5-Schwelle auf sehr tiefer Basis. Wer mehr behalten will, senkt sie — und muss
die Folgen des Verlierens gegen den Kontextgewinn abwägen. Die Bibliothek warnt
ausdrücklich, dass eine Wahrscheinlichkeit kein Beweis ist.

### Was die Quote nicht erklären kann

Ein besseres Sitzungsziel half nicht: die Median-Wahrscheinlichkeit blieb bei
0.050, die Reduktion bei 98.4 %. Das Ziel ist also nicht der Hebel, wenn die
Sitzung tatsächlich aus entbehrlichen Aufrufen besteht. Bei 2242 Nachrichten mit
einer einzigen User-Nachricht bleibt das Urteil trotzdem auf einen schmalen
Kontext gestützt — wer den Verlauf danach noch braucht, sollte die Schwelle
senken statt die Quote zu feiern.

## Lange Sitzungen: Fensterung nötig

Die Bibliothek schickt den State der **ganzen** Unterhaltung mit jeder Anfrage
und wirft, wenn er sich nicht unter `maxStateTokens` bringen lässt:

```
FEHLER: history too large for Jev (~31976 tokens after truncation, limit 25000)
```

Bei einer Sitzung mit 2'242 Nachrichten und 1'129 Tool-Calls ist das der
Normalfall — Jevs harte Request-Grenze liegt bei 32k, und die aggressivste
Anpassungsstufe der Bibliothek landet bereits bei ~32k. Die Grenze lässt sich
also nicht durch Hochsetzen von `maxStateTokens` umgehen.

Der Adapter fängt genau diesen Fehler ab und zerlegt den Verlauf in Fenster
(2, 4, 8 … bis es passt), die je separat kompaktiert werden. Die Urteile sind
pro Call lokal — dieselbe Entscheidung, die Jev für einen Call trifft, wenn er
ihn sieht.

Zwei Fallstricke bei der Fensterung:

- **Die kurzen IDs kollidieren.** Jede Anfrage vergibt `t1, t2, …` neu. Wer
  Urteile aus mehreren Fenstern einsammelt, muss sie auf die global eindeutige
  `tool_use_id` abbilden, sonst überschreiben sich die Fenster gegenseitig.
- Ein Fenster hat keinen zu schützenden „neuesten" Rand, deshalb läuft es mit
  `preserveRecentMessages: 1`.

## Herkunft und Anpassung

Vorlage: `tamaratran/fast-jev-compaction` (MIT) — ein Claude-Code-Plugin plus
npm-Bibliothek. Das Paket ist **nicht** in der npm-Registry veröffentlicht; es
muss aus der Quelle gebaut werden (`npm install && npm run build`). Klon liegt
unter `~/.hermes/tools/jev-compaction/src-repo`.

Angepasst auf Hermes:

- Der Adapter mappt das Hermes-Nachrichtenformat (`role: user|assistant|tool`,
  `tool_calls[].function.arguments` als JSON-String) auf die Bibliothek, die
  Tool-Ergebnisse als `toolResults` einer User-Nachricht erwartet.
- Die Bibliothek baut die Nachrichtenliste neu auf. Der Adapter nutzt stattdessen
  die Entscheidungen und beschneidet die **Original-Nachrichten**: entfernt wird
  nur, Call-Einträge werden aus `tool_calls` gestrichen, sonst nichts. Damit
  bleiben alle übrigen Felder (IDs, `reasoning_content`, Metadaten) erhalten.

## Politik schlägt Urteil: zustandsändernde Calls bleiben

**Der wichtigste Fund bei diesem Werkzeug.** Die geschriebene Datei strukturell
zu prüfen reicht nicht. Auf einer Sitzung mit 1128 Tool-Calls war die Ausgabe
gültig (2 Calls, 2 Ergebnisse, 0 verwaiste) — und trotzdem waren **alle 9
zustandsändernden Aufrufe** (`patch`, `write_file`) verschwunden. Der Verlauf
wusste danach nicht mehr, dass überhaupt geschrieben wurde.

Das ist das Gegenteil dessen, was Jev in einer anderen Sitzung tat: dort kam
`write_file` auf `keepResult` **1.00** und blieb. Das Urteil hängt am
Sitzungskontext und ist **nicht über Sitzungen hinweg stabil**. Darauf darf keine
Zusicherung gebaut werden.

Deshalb steht die Entscheidung im Code, nicht im Modell:

```js
const PROTECTED_TOOLS = new Set(['write_file','patch','skill_manage','memory',
  'cronjob_manage','todo','todo_list','process_manage']);
```

Wollte Jev einen solchen Call verwerfen, wird er **gerettet**: der Call bleibt,
nur sein Ergebnis wird auf Kopf + Hinweis gekürzt. Das ist die richtige
Aufteilung, denn der Aufruf trägt seine Argumente — bei `write_file` also den
geschriebenen Inhalt. Man verliert die Rückmeldung, nicht die Tatsache.

Wirkung auf derselben Sitzung: Reduktion 98.7 % → **97.3 %**, Nachrichten 14 →
34, und 7 Calls gerettet. Zwei Prozentpunkte Kontext gegen die Belegbarkeit
dessen, was die Sitzung getan hat.

### Prüfregel

Nach jedem Lauf gegen die **geschriebene Datei** prüfen, nicht gegen den
Speicher: Werkzeuge mit Zustandswirkung vorher/nachher zählen. Strukturell
gültig heisst nicht inhaltlich vollständig.

## Fallstricke

- Bei `drop_call` müssen Call **und** Ergebnis fallen. Bleibt eines übrig,
  entstehen verwaiste Einträge, die die nächste Sitzung beschädigen. Der Adapter
  prüft das am Ende und meldet es.
- Eine Assistant-Nachricht, die nach dem Streichen der Calls weder Text noch Call
  hat, wird entfernt — sonst bleibt eine leere Hülle stehen.
- Der Schlüssel gehört nie in eine Datei oder ins Gespräch. Der Aufruf liest ihn
  aus der Umgebung.
