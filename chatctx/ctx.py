#!/usr/bin/env python3
"""Effective chat instructions: the owner's private version first, the repo default second.

The repo ships generic defaults (modes/*.md, this directory's CLAUDE.md). The owner keeps
their own wording in the gitignored private root, and this resolver is how the chat agent
reads the result:

  private/chatctx/CLAUDE.md          appended after this directory's CLAUDE.md
  private/chatctx/modes/<m>.md       REPLACES modes/<m>.md
  private/chatctx/modes/<m>.add.md   appended after modes/<m>.md (or after its replacement)

usage:
  python3 ctx.py mode <analysis|injuries|goals>   _shared + the mode, resolved
  python3 ctx.py file modes/<m>.md                one resolved file
  python3 ctx.py sources                          which private files exist (paths only)

The private root is $ALKE_PRIVATE_ROOT (the desktop app sets it), else ../private next to
this directory. Without one, the output is exactly the repo defaults.
"""

import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
MODES = ("analysis", "injuries", "goals")


def private_root() -> pathlib.Path | None:
    configured = os.environ.get("ALKE_PRIVATE_ROOT")
    root = pathlib.Path(configured) if configured else HERE.parent / "private"
    return root if root.is_dir() else None


def _private(rel: str) -> pathlib.Path | None:
    root = private_root()
    path = root / "chatctx" / rel if root else None
    return path if path and path.is_file() else None


def resolve(rel: str) -> tuple[str, list[str]]:
    """Text of `rel` (relative to chatctx/) with the private override and addition applied,
    plus the list of sources used, for the agent to cite if asked."""
    default = HERE / rel
    replacement = _private(rel)
    addition = _private(rel[:-3] + ".add.md") if rel.endswith(".md") else None
    parts, sources = [], []
    if replacement:
        parts.append(replacement.read_text())
        sources.append(f"private/chatctx/{rel} (replaces the repo default)")
    elif default.is_file():
        parts.append(default.read_text())
        sources.append(f"chatctx/{rel}")
    if addition:
        parts.append(addition.read_text())
        sources.append(f"private/chatctx/{rel[:-3]}.add.md (addition)")
    if not parts:
        raise FileNotFoundError(rel)
    return "\n\n".join(p.rstrip("\n") for p in parts) + "\n", sources


def mode_text(mode: str) -> str:
    if mode not in MODES:
        mode = "analysis"
    chunks, sources = [], []
    extra = _private("CLAUDE.md")
    if extra:
        chunks.append("# The owner's private additions to CLAUDE.md\n\n" + extra.read_text().rstrip("\n") + "\n")
        sources.append("private/chatctx/CLAUDE.md (addition)")
    for rel in ("modes/_shared.md", f"modes/{mode}.md"):
        text, used = resolve(rel)
        chunks.append(text)
        sources += used
    header = "<!-- effective instructions; sources: " + "; ".join(sources) + " -->\n"
    return header + "\n".join(chunks)


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[1] == "mode":
        sys.stdout.write(mode_text(argv[2]))
        return 0
    if len(argv) >= 3 and argv[1] == "file":
        rel = argv[2].removeprefix("chatctx/")
        if ".." in pathlib.PurePosixPath(rel).parts:
            print("ctx.py: paths must stay inside chatctx/", file=sys.stderr)
            return 2
        sys.stdout.write(resolve(rel)[0])
        return 0
    if len(argv) >= 2 and argv[1] == "sources":
        root = private_root()
        if not root:
            print("no private root: repo defaults only")
            return 0
        found = sorted(p.relative_to(root).as_posix() for p in (root / "chatctx").rglob("*.md")) \
            if (root / "chatctx").is_dir() else []
        print("\n".join(f"private/{f}" for f in found) or "private root present, no chat overrides")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
