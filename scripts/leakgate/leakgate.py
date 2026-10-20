#!/usr/bin/env python3
"""Leak gate: blocks a push that would publish the owner's personal data.

Runs as the git pre-push hook (.githooks/pre-push) and as a CI job. It scans only
what is about to leave the machine: the lines and paths each new commit adds, the
commit messages, author/committer identities and tag messages in the push range.

Personal terms are never stored in this public repo. They are built at run time
from the gitignored private root (private/leak-terms.txt and the private docs),
from the database (read-only, via the same exec_readonly_sql RPC chatctx/db.py
uses) and from the local .env files, then cached inside the private root for
offline pushes. Without a private root (anyone else's clone, CI) only the generic
patterns apply.

Findings print as `sha path:line [category]`, never the matched text.

usage:
  leakgate.py pre-push <remote-name> <remote-url>   (ref lines on stdin, as git passes them)
  leakgate.py range <base> <head> [--generic-only]  (CI: commits in base..head)
  leakgate.py refresh                               (rebuild the private term cache now)
  leakgate.py check-tree                            (tracked files must never sit under private/)

A blocked push means: fix the leak (amend / rebase the commit), push again.
Never bypass the hook with --no-verify.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import time

ZERO = "0" * 40
SHINGLE = 7
CACHE_NAME = "leakgate-terms.json"
CACHE_MAX_AGE_S = 30 * 24 * 3600

# Placeholders and public addresses that are fine to publish.
ALLOWED_EMAIL = re.compile(
    r"@users\.noreply\.github\.com$|^noreply@anthropic\.com$|^noreply@openai\.com$|"
    r"@example\.(com|org|net)$|@localhost$",
    re.I,
)
ALLOWED_USER_DIRS = {"owner", "you", "user", "username", "name", "runner", "shared", "me", "<you>", "<name>"}
LOCKFILES = re.compile(r"(^|/)(package-lock\.json|deno\.lock|yarn\.lock|pnpm-lock\.yaml)$")
PRAGMA = "leakgate: allow"

GENERIC = [
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")),
    ("phone", re.compile(r"(?<![\w.+])\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b")),
    ("home-path", re.compile(r"/Users/([A-Za-z0-9._<>-]+)|/home/([a-z0-9._<>-]+)")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("supabase-key", re.compile(r"\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}")),
    ("supabase-url", re.compile(r"\b(?!your-project-ref\b)[a-z0-9]{20}\.supabase\.(?:co|in)\b")),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{10,}")),
    ("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}")),
    ("aws-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("private-key", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
    ("postgres-url", re.compile(r"postgres(?:ql)?://[^\s:@/]+:[^\s@/]+@\S+")),
    ("gpx", re.compile(r"<trkpt\b|<gpx\b", re.I)),  # leakgate: allow pattern definition
]
COORD_PAIR = re.compile(r"(?<![\w.])(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})(?![\w.])")
COORD_CONTEXT = re.compile(r"lat|lon|lng|coord|route|gps|location|geocod|place", re.I)
COORD_KV = re.compile(r"(?i)\b(lat(?:itude)?|lon(?:gitude)?|lng)\b[\"']?\s*[:=]\s*(-?\d{1,3}\.\d{3,})")
BLOCKED_PATHS = [
    ("private-root", re.compile(r"^private/")),
    ("gps-file", re.compile(r"\.(gpx|fit|tcx|kml)$", re.I)),
    ("env-file", re.compile(r"(^|/)\.env(\.(?!example$)[^/]*)?$")),
    ("medical-file", re.compile(r"^Health/|^backups/", re.I)),
]


# ---------------------------------------------------------------- utilities

def git(*args: str, cwd: pathlib.Path | None = None, check: bool = True) -> str:
    res = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                         encoding="utf-8", errors="replace")
    if check and res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {res.stderr.strip()[:200]}")
    return res.stdout


def repo_root() -> pathlib.Path:
    return pathlib.Path(git("rev-parse", "--show-toplevel").strip())


def main_checkout(repo: pathlib.Path) -> pathlib.Path:
    """The main working tree, also when running inside a linked worktree (which has no
    private/ or .env files of its own)."""
    common = git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=repo).strip()
    return pathlib.Path(common).parent if common else repo


def private_root(repo: pathlib.Path) -> pathlib.Path | None:
    configured = os.environ.get("ALKE_PRIVATE_ROOT")
    candidates = [pathlib.Path(configured)] if configured else [repo / "private", main_checkout(repo) / "private"]
    return next((c for c in candidates if c.is_dir()), None)


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9àèéìòù']+", text.lower())


def shingles(text: str) -> set[str]:
    w = words(text)
    return {" ".join(w[i:i + SHINGLE]) for i in range(len(w) - SHINGLE + 1)}


def read_env_file(path: pathlib.Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                value = value.strip().strip("'\"")
                if value:
                    out[key.strip()] = value
    return out


def env_files(repo: pathlib.Path) -> list[pathlib.Path]:
    roots = list(dict.fromkeys([repo, main_checkout(repo)]))
    return [root / rel for root in roots for rel in (".env", "app/.env", "chatctx/.env")] + \
        [pathlib.Path.home() / "Library/Application Support/health-analytics-app/.env"]


# ---------------------------------------------------------------- private terms

class Terms:
    """Personal terms for one run. `literals` are (category, term); `regexes` are
    (category, pattern); `phrases` are 7-word shingles; `boxes` are coordinate areas."""

    def __init__(self) -> None:
        self.literals: list[tuple[str, str]] = []
        self.regexes: list[tuple[str, str]] = []
        self.phrases: dict[str, str] = {}
        self.boxes: list[tuple[float, float, float, float]] = []
        self.notes: list[str] = []

    def add(self, cat: str, term: str | None, min_len: int = 4) -> None:
        term = (term or "").strip()
        if len(term) >= min_len:
            self.literals.append((cat, term))

    def add_text(self, cat: str, text: str | None) -> None:
        for s in shingles(text or ""):
            self.phrases.setdefault(s, cat)

    def to_json(self) -> dict:
        return {"built_at": time.time(), "literals": self.literals, "regexes": self.regexes,
                "phrases": self.phrases, "boxes": self.boxes}

    @classmethod
    def from_json(cls, data: dict) -> "Terms":
        t = cls()
        t.literals = [tuple(x) for x in data.get("literals", [])]
        t.regexes = [tuple(x) for x in data.get("regexes", [])]
        t.phrases = dict(data.get("phrases", {}))
        t.boxes = [tuple(x) for x in data.get("boxes", [])]
        return t

    def merge(self, other: "Terms") -> None:
        self.literals += other.literals
        self.regexes += other.regexes
        for k, v in other.phrases.items():
            self.phrases.setdefault(k, v)
        self.boxes += other.boxes


def leak_terms_file(priv: pathlib.Path, terms: Terms) -> None:
    """private/leak-terms.txt: one term per line; `re: <regex>` for patterns; # comments."""
    path = priv / "leak-terms.txt"
    if not path.is_file():
        return
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("re:"):
            terms.regexes.append(("private-term", line[3:].strip()))
        else:
            terms.add("private-term", line, min_len=3)


def env_secret_terms(repo: pathlib.Path, terms: Terms) -> dict[str, str]:
    merged: dict[str, str] = {}
    for path in env_files(repo):
        for key, value in read_env_file(path).items():
            merged.setdefault(key, value)
            if re.search(r"URL|KEY|TOKEN|SECRET|PASSWORD", key) and len(value) >= 12:
                terms.add("secret", value, min_len=12)
                m = re.match(r"https://([a-z0-9]{20})\.supabase\.co", value)
                if m:
                    terms.add("secret", m.group(1), min_len=12)
    return merged


def private_doc_phrases(priv: pathlib.Path, repo: pathlib.Path, public_rev: str | None, terms: Terms) -> None:
    """7-word phrases from the private markdown, minus phrases ALREADY PUBLIC at `public_rev`
    (the remote's side of the push), so an override that shares wording with its public
    default doesn't block, while text newly copied out of a private doc does."""
    private_ph: set[str] = set()
    for md in priv.rglob("*.md"):
        rel = md.relative_to(priv).parts
        # Skipped: the science library and plans/specs (written to become public code, so
        # their wording legitimately reappears there), plus machine-local folders.
        if rel and rel[0] in ("knowledge", "docs", ".cache", "backups", "exports"):
            continue
        if rel == ("README.md",):  # the folder's own generic map, not personal content
            continue
        try:
            private_ph |= shingles(md.read_text(errors="replace"))
        except OSError:
            continue
    if not private_ph:
        return
    public_ph: set[str] = set()
    listing = git("ls-tree", "-r", "-z", "--format=%(objectname) %(objecttype) %(path)", public_rev,
                  cwd=repo) if public_rev else ""
    blobs = [e.split(" ", 2) for e in listing.split("\0") if e]
    shas = [sha for sha, kind, path in blobs if kind == "blob" and not LOCKFILES.search(path)]
    if shas:
        proc = subprocess.run(["git", "cat-file", "--batch"], cwd=repo, input="\n".join(shas).encode(),
                              capture_output=True, check=True)
        data, pos = proc.stdout, 0
        while pos < len(data):
            nl = data.index(b"\n", pos)
            size = int(data[pos:nl].split()[2])
            body = data[nl + 1:nl + 1 + size]
            pos = nl + 2 + size
            if b"\0" not in body[:8000]:
                public_ph |= shingles(body.decode("utf-8", "replace"))
    for s in private_ph - public_ph:
        terms.phrases.setdefault(s, "private-doc")


def db_terms(repo: pathlib.Path, env: dict[str, str]) -> Terms:
    """Read-only: the same exec_readonly_sql RPC the chat agent's db.py uses."""
    for key in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if env.get(key):
            os.environ.setdefault(key, env[key])
    sys.path.insert(0, str(repo / "chatctx"))
    import db  # chatctx/db.py

    def q(sql: str) -> list[dict]:
        try:
            rows = db.run_query(sql)
        except SystemExit as e:  # db.py exits with a one-line message on failure
            raise RuntimeError(str(e)) from None
        # exec_readonly_sql returns null for an all-null row; keep real rows only.
        return [r for r in (rows or []) if isinstance(r, dict)]

    t = Terms()
    uc = (q("select birthdate::text bd, timezone, about_me, hr_max, height_cm from user_config") or [{}])[0]
    if uc.get("bd"):
        y, m, d = uc["bd"].split("-")
        t.add("identity", uc["bd"])
        t.regexes.append(("identity", rf"\b0?{int(d)}[/.-]0?{int(m)}[/.-](?:{y}|{y[2:]})\b"))
        t.regexes.append(("identity", rf"\b0?{int(m)}[/.-]0?{int(d)}[/.-]{y}\b"))
    if uc.get("timezone") and uc["timezone"] not in ("UTC", "Etc/UTC"):
        t.add("place", uc["timezone"])
    if uc.get("hr_max"):
        t.regexes.append(("health", rf"(?i)(?:hr_?max|max(?:imum)?[ _]?hr|max heart rate)\D{{0,12}}{uc['hr_max']}\b"))
    if uc.get("height_cm"):
        t.regexes.append(("health", rf"(?i)height\w*\D{{0,8}}{int(float(uc['height_cm']))}\b"))
    t.add_text("about-me", uc.get("about_me"))
    for r in q("select name, summary, recovery_plan from injuries"):
        t.add("injury", r["name"], min_len=8)
        t.add_text("injury", r["summary"]); t.add_text("injury", r["recovery_plan"])
    for r in q("select note from injury_notes"):
        t.add_text("injury-note", r["note"])
    for r in q("select title, description from goals"):
        t.add("goal", r["title"], min_len=8)
        t.add_text("goal", r["description"])
    for r in q("select distinct name, notes from gym_templates"):
        t.add("template", r["name"], min_len=8)
        t.add_text("template", r["notes"])
    for r in q("select note from recovery_plan_items"):
        t.add_text("rehab-plan", r["note"])
    for r in q("select distinct lab from blood_panels"):
        for part in re.split(r"[/,—–]", r["lab"] or ""):
            t.add("lab", part, min_len=6)
    countries = {r["country"] for r in q("select distinct country from workout_geo") if r.get("country")}
    for r in q("select distinct city, admin from workout_geo"):
        for name in (r.get("city"), r.get("admin")):
            for part in re.split(r"\s*-\s*|,", name or ""):
                if part.strip() not in countries:
                    t.add("place", part, min_len=5)
    for r in q("select round(lat, 1) la, round(lon, 1) lo from workout_geo group by 1, 2"):
        la, lo = float(r["la"]), float(r["lo"])
        t.boxes.append((la - 0.15, la + 0.15, lo - 0.15, lo + 0.15))
    for r in q("select summary, open_threads, next_steps from session_handoffs"):
        for k in ("summary", "open_threads", "next_steps"):
            t.add_text("handoff", r[k])
    for r in q("select m->>'text' t from chat_sessions, jsonb_array_elements(messages) m where m->>'role' = 'user'"):
        t.add_text("chat", r.get("t"))
    return t


def load_private_terms(repo: pathlib.Path, priv: pathlib.Path, public_rev: str | None,
                       refresh: bool = False) -> Terms:
    terms = Terms()
    leak_terms_file(priv, terms)
    env = env_secret_terms(repo, terms)
    private_doc_phrases(priv, repo, public_rev, terms)
    cache = priv / ".cache" / CACHE_NAME
    dbt: Terms | None = None
    if os.environ.get("LEAKGATE_SKIP_DB") == "1":
        terms.notes.append("database terms SKIPPED (LEAKGATE_SKIP_DB=1, meant for tests only)")
    else:
        try:
            if not (env.get("SUPABASE_URL") and env.get("SUPABASE_SERVICE_KEY")):
                raise RuntimeError("no SUPABASE_URL / SUPABASE_SERVICE_KEY in the local .env files")
            dbt = db_terms(repo, env)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(dbt.to_json()))
            os.chmod(cache, 0o600)
        except Exception as e:  # network, auth, schema, bad rows: fall back to the cache
            if cache.is_file() and not refresh:
                data = json.loads(cache.read_text())
                age_d = (time.time() - data.get("built_at", 0)) / 86400
                dbt = Terms.from_json(data)
                terms.notes.append(f"could not read the database ({e}); using the cached term list from {age_d:.0f} day(s) ago")
                if age_d * 86400 > CACHE_MAX_AGE_S:
                    terms.notes.append("the cache is over 30 days old: run `npm run leakgate:refresh` when online")
            else:
                raise RuntimeError(
                    f"cannot build the private term list: could not read the database ({e}) and no cache yet. "
                    "Run `npm run leakgate:refresh` once you are online, then push again."
                ) from None
    if dbt:
        terms.merge(dbt)
    return terms


# ---------------------------------------------------------------- matching

class Matcher:
    def __init__(self, terms: Terms | None) -> None:
        self.terms = terms
        self.private: list[tuple[str, re.Pattern]] = []
        if terms:
            for cat, term in terms.literals:
                pat = re.escape(term)
                if re.match(r"\w", term) and re.search(r"\w$", term):
                    pat = r"(?<![A-Za-z0-9])" + pat + r"(?![A-Za-z0-9])"
                self.private.append((cat, re.compile(pat, re.I)))
            for cat, pat in terms.regexes:
                try:
                    self.private.append((cat, re.compile(pat, re.I)))
                except re.error:
                    pass

    def _near_owner(self, la: float, lo: float) -> bool:
        return any(a <= la <= b and c <= lo <= d for a, b, c, d in (self.terms.boxes if self.terms else []))

    def line(self, text: str, path: str = "") -> list[str]:
        """Categories found on one line. Private categories ignore the inline pragma."""
        cats: list[str] = []
        for cat, rx in self.private:
            if rx.search(text):
                cats.append(cat)
        for m in COORD_PAIR.finditer(text):
            la, lo = float(m.group(1)), float(m.group(2))
            if self._near_owner(la, lo) or self._near_owner(lo, la):
                cats.append("owner-location")
        if PRAGMA in text:
            return cats
        lock = bool(LOCKFILES.search(path))
        for cat, rx in GENERIC:
            for m in rx.finditer(text):
                if lock and cat in ("email",):
                    continue
                if cat == "email" and ALLOWED_EMAIL.search(m.group(0)):
                    continue
                if cat == "home-path":
                    user = (m.group(1) or m.group(2) or "").lower()
                    if user in ALLOWED_USER_DIRS or user.startswith(("$", "<", "{")):
                        continue
                cats.append(cat)
                break
        if COORD_CONTEXT.search(text) and COORD_PAIR.search(text):
            for m in COORD_PAIR.finditer(text):
                la, lo = float(m.group(1)), float(m.group(2))
                if 1 <= abs(la) <= 90 and 1 <= abs(lo) <= 180:
                    cats.append("coordinates")
                    break
        if COORD_KV.search(text):
            cats.append("coordinates")
        return sorted(set(cats))

    def phrases(self, text: str) -> dict[int, str]:
        """Line number (1-based within `text`) -> category, for private phrases."""
        if not self.terms or not self.terms.phrases:
            return {}
        found: dict[int, str] = {}
        toks = [(m.group(0), m.start()) for m in re.finditer(r"[a-z0-9àèéìòù']+", text.lower())]
        for i in range(len(toks) - SHINGLE + 1):
            cat = self.terms.phrases.get(" ".join(t for t, _ in toks[i:i + SHINGLE]))
            if cat:
                found.setdefault(text.count("\n", 0, toks[i][1]) + 1, cat)
        return found


# ---------------------------------------------------------------- scanning

def added_lines(repo: pathlib.Path, sha: str):
    """Yield (path, line_no, text) for lines `sha` adds relative to its first parent,
    plus (path, 0, None) for every path it adds or changes."""
    diff = git("show", "--format=", "-U0", "--no-color", "--no-ext-diff", "--no-renames",
               "--diff-merges=first-parent", sha, cwd=repo)
    path, new_no = None, 0
    for raw in diff.split("\n"):
        if raw.startswith("+++ "):
            path = None if raw[4:] == "/dev/null" else raw[6:] if raw.startswith("+++ b/") else raw[4:]
            if path:
                yield path, 0, None
        elif raw.startswith("Binary files ") and " and b/" in raw:
            yield raw.rsplit(" and b/", 1)[1].rsplit(" differ", 1)[0], 0, None
        elif raw.startswith("@@"):
            m = re.search(r"\+(\d+)", raw)
            new_no = int(m.group(1)) if m else 0
        elif raw.startswith("+") and path:
            yield path, new_no, raw[1:]
            new_no += 1


def scan_commit(repo: pathlib.Path, sha: str, matcher: Matcher) -> list[str]:
    out: list[str] = []
    short = sha[:7]
    meta = git("show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", sha, cwd=repo)
    an, ae, cn, ce, body = meta.split("\x00", 4)
    # Author/committer NAMES are deliberately public (they sit on every commit); only
    # the email is checked, and it must be a noreply/placeholder address.
    for who, email in (("author", ae), ("committer", ce)):
        if email and not ALLOWED_EMAIL.search(email):
            out.append(f"{short} ({who} email) [email]")
    for n, line in enumerate(body.split("\n"), 1):
        for cat in matcher.line(line):
            out.append(f"{short} (commit message line {n}) [{cat}]")
    for n, cat in matcher.phrases(body).items():
        out.append(f"{short} (commit message line {n}) [{cat}]")
    by_file: dict[str, list[tuple[int, str]]] = {}
    for path, no, text in added_lines(repo, sha):
        if text is None:
            for cat, rx in BLOCKED_PATHS:
                if rx.search(path) and not path.endswith(".env.example"):
                    out.append(f"{short} {path} [{cat}]")
            continue
        by_file.setdefault(path, []).append((no, text))
        for cat in matcher.line(text, path):
            out.append(f"{short} {path}:{no} [{cat}]")
    for path, rows in by_file.items():
        joined = "\n".join(t for _, t in rows)
        for idx, cat in matcher.phrases(joined).items():
            out.append(f"{short} {path}:{rows[idx - 1][0]} [{cat}]")
    return out


def scan_tag(repo: pathlib.Path, ref: str, matcher: Matcher) -> list[str]:
    if git("cat-file", "-t", ref, cwd=repo).strip() != "tag":
        return []
    body = git("cat-file", "-p", ref, cwd=repo)
    return [f"{ref} (tag message) [{c}]" for line in body.split("\n") for c in matcher.line(line)]


def commits_to_push(repo: pathlib.Path, local: str, remote_sha: str, remote_name: str) -> list[str]:
    known = remote_sha != ZERO and subprocess.run(
        ["git", "cat-file", "-e", f"{remote_sha}^{{commit}}"], cwd=repo, capture_output=True).returncode == 0
    if known:
        rng = [f"{remote_sha}..{local}"]
    else:
        # New branch: everything not already on this remote. With no tracking refs for it
        # yet, fall back to origin's, so a fresh remote doesn't mean rescanning all history.
        has_refs = bool(git("for-each-ref", "--count=1", f"refs/remotes/{remote_name}/", cwd=repo).strip())
        rng = [local, "--not", f"--remotes={remote_name if has_refs else 'origin'}"]
    return git("rev-list", "--reverse", *rng, cwd=repo).split()


def public_side(repo: pathlib.Path, updates: list[list[str]], remote_name: str) -> str | None:
    """The commit that represents what is already public for this push: the remote's
    current tip of the first updated ref, else its remote-tracking main, else nothing."""
    def exists(rev: str) -> bool:
        return subprocess.run(["git", "cat-file", "-e", f"{rev}^{{commit}}"], cwd=repo,
                              capture_output=True).returncode == 0
    for _, _, remote_ref, remote_sha in updates:
        if remote_sha != ZERO and exists(remote_sha):
            return remote_sha
    for ref in (f"refs/remotes/{remote_name}/HEAD", f"refs/remotes/{remote_name}/main",
                "refs/remotes/origin/HEAD", "refs/remotes/origin/main"):
        if exists(ref):
            return ref
    return None


def check_tree(repo: pathlib.Path, rev: str = "HEAD") -> list[str]:
    out = []
    tracked = git("ls-tree", "-r", "--name-only", rev, "--", "private", cwd=repo).split()
    out += [f"{rev[:7]} {p} [private-root tracked]" for p in tracked]
    gi = repo / ".gitignore"
    if gi.is_file():
        for n, line in enumerate(gi.read_text().splitlines(), 1):
            if line.strip().startswith("!") and "private" in line:
                out.append(f".gitignore:{n} [re-includes the private root]")
    return out


def report(findings: list[str], notes: list[str]) -> int:
    for note in notes:
        print(f"leakgate: note: {note}", file=sys.stderr)
    if not findings:
        print("leakgate: clean", file=sys.stderr)
        return 0
    uniq = list(dict.fromkeys(findings))
    print(f"leakgate: BLOCKED, {len(uniq)} finding(s). The matched text is not shown.", file=sys.stderr)
    for f in uniq[:200]:
        print(f"  {f}", file=sys.stderr)
    if len(uniq) > 200:
        print(f"  … and {len(uniq) - 200} more", file=sys.stderr)
    print("Fix the leak (amend or rebase the commit), then push again. Never use --no-verify.",
          file=sys.stderr)
    return 1


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    mode = argv[1]
    repo = repo_root()
    if mode == "check-tree":
        return report(check_tree(repo), [])
    if mode == "refresh":
        priv = private_root(repo)
        if not priv:
            print("leakgate: no private root; nothing to refresh", file=sys.stderr)
            return 1
        t = load_private_terms(repo, priv, "HEAD", refresh=True)
        print(f"leakgate: cached {len(t.literals)} terms, {len(t.phrases)} phrases, {len(t.boxes)} areas",
              file=sys.stderr)
        return 0
    generic_only = "--generic-only" in argv
    notes: list[str] = []
    priv = None if generic_only else private_root(repo)
    terms = None
    if mode == "pre-push":
        remote_name = argv[2] if len(argv) > 2 else "origin"
        updates = [l.split() for l in sys.stdin.read().splitlines() if l.strip()]
        if priv:
            terms = load_private_terms(repo, priv, public_side(repo, updates, remote_name))
            notes += terms.notes
        else:
            notes.append("no private root found: generic patterns only")
        matcher = Matcher(terms)
        findings: list[str] = []
        for local_ref, local_sha, remote_ref, remote_sha in updates:
            if local_sha == ZERO:
                continue
            if local_ref.startswith("refs/tags/"):
                findings += scan_tag(repo, local_ref, matcher)
            for sha in commits_to_push(repo, local_sha, remote_sha, remote_name):
                findings += scan_commit(repo, sha, matcher)
            findings += check_tree(repo, local_sha)
        return report(findings, notes)
    if mode == "range":
        base, head = argv[2], argv[3]
        if priv:
            terms = load_private_terms(repo, priv, None if base in (ZERO, "") else base)
            notes += terms.notes
        matcher = Matcher(terms)
        if base == ZERO or not base:
            shas = git("rev-list", "--reverse", head, "--not", "--remotes=origin", cwd=repo).split() or [head]
        else:
            shas = git("rev-list", "--reverse", f"{base}..{head}", cwd=repo).split()
        findings = [f for sha in shas for f in scan_commit(repo, sha, matcher)]
        findings += check_tree(repo, head)
        return report(findings, notes)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # fail closed: an internal error blocks the push
        print(f"leakgate: BLOCKED, internal error: {e}", file=sys.stderr)
        sys.exit(1)
