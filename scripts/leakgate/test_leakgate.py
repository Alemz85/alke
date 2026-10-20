"""End-to-end tests for the leak gate: real git repos, a real pre-push hook, a local
bare remote. The private term used here is a made-up fixture, never real data."""

import os
import pathlib
import shutil
import subprocess
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
FIXTURE_TERM = "Zorblax Quarry Lane"   # fictional "private" term


def run(cmd, cwd, env=None, check=True):
    res = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if check and res.returncode != 0:
        raise AssertionError(f"{cmd} failed:\n{res.stdout}\n{res.stderr}")
    return res


@pytest.fixture
def repo(tmp_path):
    """A clone-like working repo with the gate installed and an empty bare remote."""
    remote = tmp_path / "remote.git"
    work = tmp_path / "work"
    run(["git", "init", "-q", "--bare", str(remote)], tmp_path)
    run(["git", "init", "-q", "-b", "main", str(work)], tmp_path)
    (work / "scripts" / "leakgate").mkdir(parents=True)
    shutil.copy(HERE / "leakgate.py", work / "scripts" / "leakgate" / "leakgate.py")
    shutil.copytree(REPO / ".githooks", work / ".githooks")
    (work / ".gitignore").write_text("/private/\n")
    for args in (["config", "user.name", "Test Owner"], ["config", "user.email", "test@example.com"],
                 ["config", "core.hooksPath", ".githooks"], ["remote", "add", "origin", str(remote)]):
        run(["git", *args], work)
    run(["git", "add", "-A"], work)
    run(["git", "commit", "-q", "-m", "init"], work)
    return work


def gate_env(**extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("SUPABASE_", "ALKE_"))}
    env.update(LEAKGATE_SKIP_DB="1", HOME=extra.pop("HOME", env.get("HOME", "")))
    env.update(extra)
    return env


def make_private(work, term=FIXTURE_TERM):
    priv = work / "private"
    priv.mkdir()
    (priv / "leak-terms.txt").write_text(f"# fixture\n{term}\n")
    return priv


def commit(work, path, text, msg="change"):
    p = work / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    run(["git", "add", path], work)
    run(["git", "commit", "-q", "-m", msg], work)


def push(work, env):
    return run(["git", "push", "-q", "origin", "main"], work, env=env, check=False)


def test_clean_push_passes(repo, tmp_path):
    make_private(repo)
    commit(repo, "app/notes.md", "Nothing personal in here.\n")
    res = push(repo, gate_env(HOME=str(tmp_path)))
    assert res.returncode == 0, res.stderr
    assert "leakgate: clean" in res.stderr


def test_private_term_blocks_push_without_echoing_it(repo, tmp_path):
    make_private(repo)
    commit(repo, "app/notes.md", f"line one\nwe met at {FIXTURE_TERM} yesterday\n")
    res = push(repo, gate_env(HOME=str(tmp_path)))
    assert res.returncode != 0
    assert "app/notes.md:2 [private-term]" in res.stderr
    assert FIXTURE_TERM.lower() not in (res.stdout + res.stderr).lower()
    # nothing reached the remote
    assert run(["git", "ls-remote", "origin"], repo).stdout.strip() == ""


def test_private_term_in_commit_message_blocks(repo, tmp_path):
    make_private(repo)
    commit(repo, "a.txt", "ok\n", msg=f"fix: bug seen near {FIXTURE_TERM}")
    res = push(repo, gate_env(HOME=str(tmp_path)))
    assert res.returncode != 0
    assert "(commit message line 1) [private-term]" in res.stderr


def test_inline_pragma_never_allows_a_private_term(repo, tmp_path):
    make_private(repo)
    commit(repo, "a.txt", f"{FIXTURE_TERM}  # leakgate: allow fixture\n")
    assert push(repo, gate_env(HOME=str(tmp_path))).returncode != 0


def test_private_doc_phrase_copied_into_public_file_blocks(repo, tmp_path):
    priv = make_private(repo)
    sentence = "the owner keeps a very particular stretching routine every single morning"
    (priv / "notes.md").write_text(sentence + "\n")
    commit(repo, "docs/guide.md", f"Intro.\n{sentence}\n")
    res = push(repo, gate_env(HOME=str(tmp_path)))
    assert res.returncode != 0
    assert "docs/guide.md:2 [private-doc]" in res.stderr


@pytest.mark.parametrize("line,cat", [
    ("contact: someone.real@gmail.com", "email"),  # leakgate: allow test fixture
    ("path = '/Users/jdoe/Projects/x'", "home-path"),  # leakgate: allow test fixture
    ("key = 'sb_secret_abcdefghijklmnop'", "supabase-key"),  # leakgate: allow test fixture
    ("route start lat/lon (45.1234, 7.6543)", "coordinates"),  # leakgate: allow test fixture
    ('{"latitude": 45.12345}', "coordinates"),  # leakgate: allow test fixture
    ("-----BEGIN PRIVATE KEY-----", "private-key"),  # leakgate: allow test fixture
])
def test_generic_patterns_block_without_private_root(repo, tmp_path, line, cat):
    commit(repo, "x.txt", line + "\n")
    res = push(repo, gate_env(HOME=str(tmp_path)))
    assert res.returncode != 0
    assert f"x.txt:1 [{cat}]" in res.stderr
    assert "generic patterns only" in res.stderr


@pytest.mark.parametrize("line", [
    "author: 123+someone@users.noreply.github.com",  # leakgate: allow test fixture
    "path = '/Users/owner/Projects/x'",
    "url = 'https://your-project-ref.supabase.co'",  # leakgate: allow test fixture
    "synthetic route (45.1234, 7.6543)  # leakgate: allow synthetic fixture",
])
def test_generic_allowlist_and_pragma(repo, tmp_path, line):
    commit(repo, "x.txt", line + "\n")
    assert push(repo, gate_env(HOME=str(tmp_path))).returncode == 0


def test_personal_author_email_blocks(repo, tmp_path):
    run(["git", "config", "user.email", "someone.real@gmail.com"], repo)  # leakgate: allow test fixture
    commit(repo, "a.txt", "ok\n")
    res = push(repo, gate_env(HOME=str(tmp_path)))
    assert res.returncode != 0
    assert "(author email) [email]" in res.stderr


def test_files_under_private_or_gps_files_block(repo, tmp_path):
    commit(repo, "data/ride.gpx", "not really gpx\n")
    res = push(repo, gate_env(HOME=str(tmp_path)))
    assert res.returncode != 0
    assert "data/ride.gpx [gps-file]" in res.stderr


def test_private_root_without_db_or_cache_blocks(repo, tmp_path):
    make_private(repo)
    commit(repo, "a.txt", "ok\n")
    env = gate_env(HOME=str(tmp_path))
    env.pop("LEAKGATE_SKIP_DB")
    res = push(repo, env)
    assert res.returncode != 0
    assert "cannot build the private term list" in res.stderr


def test_only_the_push_range_is_scanned(repo, tmp_path):
    # A term already on the remote is not re-reported; only new commits are scanned.
    commit(repo, "old.txt", "contact: someone.real@gmail.com  # leakgate: allow pre-existing\n")
    assert push(repo, gate_env(HOME=str(tmp_path))).returncode == 0
    commit(repo, "new.txt", "fine\n")
    res = push(repo, gate_env(HOME=str(tmp_path)))
    assert res.returncode == 0, res.stderr


def test_range_mode_generic_only(repo, tmp_path):
    base = run(["git", "rev-parse", "HEAD"], repo).stdout.strip()
    commit(repo, "x.txt", "contact: someone.real@gmail.com\n")  # leakgate: allow test fixture
    head = run(["git", "rev-parse", "HEAD"], repo).stdout.strip()
    res = run([sys.executable, "scripts/leakgate/leakgate.py", "range", base, head, "--generic-only"],
              repo, env=gate_env(HOME=str(tmp_path)), check=False)
    assert res.returncode != 0
    assert "x.txt:1 [email]" in res.stderr


def test_override_sharing_wording_with_public_default_does_not_block(repo, tmp_path):
    # The public default is already on the remote; a private override repeats most of it.
    sentence = "read the goals table first and then compare against the weekly target"
    commit(repo, "chatctx/modes/goals.md", sentence + "\n")
    assert push(repo, gate_env(HOME=str(tmp_path))).returncode == 0
    priv = make_private(repo)
    (priv / "chatctx").mkdir()
    (priv / "chatctx" / "goals.md").write_text(sentence + "\nplus my own private habit notes here\n")
    commit(repo, "chatctx/modes/goals.md", sentence + "\nedited default\n")
    res = push(repo, gate_env(HOME=str(tmp_path)))
    assert res.returncode == 0, res.stderr
