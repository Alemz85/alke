---
name: health
description: Route a health-chat session to its mode. Invoked as /health <mode> at session start; reads the mode's instruction files, then handles the rest of the message.
---

# Health mode router

The first word of the arguments is the mode name; anything after it is the user's actual message. BEFORE doing anything else, run `python3 ctx.py mode <mode>` from the chat working directory and follow what it prints for the rest of the session, then respond to the message if one was included.

`ctx.py` prints the mode's files with the owner's private overrides applied: a private version of a file replaces the repo default, a private `.add.md` is appended after it, and a private `CLAUDE.md` addition comes first. Its first line lists the sources it used. Do not read `modes/*.md` directly: you would miss the overrides.

| mode | what `ctx.py mode <mode>` resolves |
|------|---------------|
| analysis (default) | `modes/_shared.md`, `modes/analysis.md` |
| injuries | `modes/_shared.md`, `modes/injuries.md` |
| goals | `modes/_shared.md`, `modes/goals.md` |

Unknown or missing mode → treat as `analysis`. New modes are added by adding a row here, a `modes/<name>.md` file and the name to `MODES` in `ctx.py`.

The app's chat always routes `analysis`; the deeper role files are then read lazily mid-session when the topic calls for them, through `python3 ctx.py file modes/<role>.md` (see `modes/analysis.md`, "When the conversation crosses into another role"). The `injuries` and `goals` rows remain for headless invocations pinned to one role from the start (e.g. background goal-metric builds).
