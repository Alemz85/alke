"""ctx.py: private override first, repo default second."""

import importlib.util
import pathlib

import pytest

CHATCTX = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ctx", CHATCTX / "ctx.py")
ctx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctx)


@pytest.fixture
def private(tmp_path, monkeypatch):
    root = tmp_path / "private"
    (root / "chatctx" / "modes").mkdir(parents=True)
    monkeypatch.setenv("ALKE_PRIVATE_ROOT", str(root))
    return root


def test_no_private_root_gives_repo_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("ALKE_PRIVATE_ROOT", str(tmp_path / "missing"))
    text, sources = ctx.resolve("modes/analysis.md")
    assert text == (CHATCTX / "modes" / "analysis.md").read_text().rstrip("\n") + "\n"
    assert sources == ["chatctx/modes/analysis.md"]


def test_private_replacement_wins(private):
    (private / "chatctx" / "modes" / "goals.md").write_text("MY GOALS RULES\n")
    text, sources = ctx.resolve("modes/goals.md")
    assert text == "MY GOALS RULES\n"
    assert "replaces" in sources[0]


def test_addition_is_appended_after_default(private):
    (private / "chatctx" / "modes" / "injuries.add.md").write_text("EXTRA INJURY NOTES\n")
    text, _ = ctx.resolve("modes/injuries.md")
    default = (CHATCTX / "modes" / "injuries.md").read_text().rstrip("\n")
    assert text.startswith(default)
    assert text.rstrip().endswith("EXTRA INJURY NOTES")


def test_mode_text_includes_private_claude_md_shared_and_mode(private):
    (private / "chatctx" / "CLAUDE.md").write_text("PERSONAL CONTEXT\n")
    (private / "chatctx" / "modes" / "_shared.add.md").write_text("SHARED EXTRA\n")
    out = ctx.mode_text("analysis")
    assert out.index("PERSONAL CONTEXT") < out.index("SHARED EXTRA")
    assert "private/chatctx/CLAUDE.md (addition)" in out.splitlines()[0]
    assert (CHATCTX / "modes" / "analysis.md").read_text().splitlines()[0] in out


def test_unknown_mode_falls_back_to_analysis(private):
    assert ctx.mode_text("nonsense") == ctx.mode_text("analysis")


def test_file_command_refuses_paths_outside_chatctx(capsys):
    assert ctx.main(["ctx.py", "file", "../app/.env"]) == 2
