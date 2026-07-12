---
name: knowledge-ingest
description: Add or update an entry in the knowledge library (the private health-knowledge repo cloned at ./knowledge). Use when ingesting a research paper (PDF, URL, or pasted Claude research report) into the training-science library the chat agent reads. Triggers include "add this paper to the knowledge library", "ingest this study", "summarize this research into knowledge/", or dropping a PDF in knowledge/papers/_inbox/.
---

# Knowledge library ingestion

The library lives in `./knowledge/` (a separate private git repo — see
`knowledge/README.md`). Its value is **curation, not accumulation**: an
uncurated pile of PDFs makes the chat agent hallucinate *worse* because it
retrieves a weak study and cites it authoritatively. Honest quality metadata is
the mitigation and the single most important step below — never skip it.

## Structure (recap)

- `INDEX.md` — one line per entry; the only file the agent always reads. Keep it cheap.
- `topics/<slug>.md` — distilled synthesis of a question; the primary interface.
- `papers/<slug>.md` — one paper, metadata header + converted body; the appendix.
- `papers/_inbox/` — drop zone for raw PDFs (gitignored).

## Steps for every addition

1. **Take the input.** A PDF in `papers/_inbox/`, a pasted research report, or a URL.
2. **Convert to markdown.** For a URL, use WebFetch and pull the actual reported
   numbers. For a PDF, the Read tool handles shorter papers directly; for long or
   scanned ones try `marker` or PyMuPDF. **Reuse what you actually fetched/read —
   never backfill numbers from memory.** If a figure isn't in the source, say so
   rather than inventing it.
3. **Write the paper file** `papers/<slug>.md` with the YAML-ish header:
   `slug, title, authors, year, journal, design, n, population, source_url,
   source_pdf, added (YYYY-MM-DD), quality`. Fill `quality` honestly — n,
   population, design limits, and specifically **whether it transfers to this
   user** (a detrained beginner rebuilding aerobic base; knee pain,
   shoulder impingement; swim-primary). "n=14 trained cyclists, transfer to a
   detrained beginner uncertain" is the kind of note that earns its place.
4. **Length-match depth to importance — within the file, not just across files.**
   A load-bearing claim (one the agent will reason from, or that corrects a common
   error) gets real explanation of the mechanism and why it matters; an incidental
   finding gets a line. Do not flatten everything to uniform bullet points, and do
   not pad a minor paper to look thorough. The most decision-relevant claim in a
   paper should visibly get the most words.
5. **Write or update the topic synthesis** `topics/<slug>.md` (header: `slug,
   question, confidence, date_written, applies_to_user, citations`). This is what
   the agent reads for an answer — state the claim, its strength, and the
   "applies to user?" caveat. Point `citations` at the paper files.
6. **Update `INDEX.md`** — add/edit the one-line entry (topics section and/or
   papers section) with the core claim + a quality/date note.
7. **Reconcile contradictions.** If the new evidence contradicts an existing
   topic file, update that topic and note the revision with its date — don't
   leave two files disagreeing silently.

## Curation loop (when revising, not just adding)

Before re-curating, check whether the chat agent has flagged an entry as weak:

```
python3 chatctx/agent_log.py counts --category knowledge
```

Any file with ≥2 flags from distinct sessions is a re-review candidate —
tighten its quality notes, correct it against better evidence, or remove it.

## After writing

Commit inside the knowledge repo (it has its own history, separate from the app):

```
cd knowledge && git add -A && git commit -m "Add <slug>: <one-line>"
```

Pushing is the user's call (it's an outward action to a private remote) — offer,
don't auto-push, unless they've said to.
