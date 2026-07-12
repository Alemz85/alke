---
name: health
description: Route a health-chat session to its mode. Invoked as /health <mode> at session start; reads the mode's instruction files, then handles the rest of the message.
---

# Health mode router

The first word of the arguments is the mode name; anything after it is the user's actual message. Read the mode's files (paths relative to the chat working directory) BEFORE doing anything else, follow them for the rest of the session, then respond to the message if one was included.

| mode | files to read |
|------|---------------|
| analysis (default) | `modes/_shared.md`, `modes/analysis.md` |
| injuries | `modes/_shared.md`, `modes/injuries.md` |
| goals | `modes/_shared.md`, `modes/goals.md` |

Unknown or missing mode → treat as `analysis`. The mapping is a table, not logic — new modes are added by adding a row and a `modes/<name>.md` file.
