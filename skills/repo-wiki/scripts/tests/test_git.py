import subprocess

import pytest

import _git
from helpers import commit, git_repo


def _sh(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def test_toplevel_and_head(tmp_path):
    repo = git_repo(tmp_path / "r", {"a.txt": "a\n"})
    (repo / "sub").mkdir()
    assert _git.toplevel(repo / "sub") == repo.resolve()
    assert _git.toplevel(tmp_path) is None
    assert _git.toplevel(tmp_path / "missing") is None
    sha = _git.head(repo)
    assert len(sha) == 40
    assert _git.rev_exists(repo, sha)
    assert _git.rev_exists(repo, "main")
    assert not _git.rev_exists(repo, "0" * 40)
    assert not _git.rev_exists(repo, "--all")


def test_errors_carry_stderr(tmp_path):
    repo = git_repo(tmp_path / "r", {"a.txt": "a\n"})
    with pytest.raises(_git.GitError) as info:
        _git.ls_files(repo, "no-such-rev")
    assert info.value.stderr
    with pytest.raises(_git.GitError):
        _git.head(tmp_path)


def test_is_clean_tracked_only_with_exclude(tmp_path):
    repo = git_repo(tmp_path / "r", {"src/a.py": "a\n", "docs/wiki/x.md": "x\n", "b c.txt": "b\n"})
    assert _git.is_clean(repo) == (True, [])
    (repo / "untracked.txt").write_text("u\n")
    assert _git.is_clean(repo) == (True, [])
    (repo / "docs/wiki/x.md").write_text("changed\n")
    assert _git.is_clean(repo) == (False, ["docs/wiki/x.md"])
    assert _git.is_clean(repo, ["docs/wiki"]) == (True, [])
    assert _git.is_clean(repo, ["docs/wiki/"]) == (True, [])
    assert _git.is_clean(repo, ["docs/wi"]) == (False, ["docs/wiki/x.md"])
    (repo / "b c.txt").write_text("changed\n")
    (repo / "src/a.py").unlink()
    assert _git.is_clean(repo, ["docs/wiki"]) == (False, ["b c.txt", "src/a.py"])


def test_is_clean_staged_rename(tmp_path):
    repo = git_repo(tmp_path / "r", {"old.txt": "same\n"})
    _sh(repo, "mv", "old.txt", "new.txt")
    clean, dirty = _git.is_clean(repo)
    assert not clean and dirty == ["new.txt", "old.txt"]


def test_ls_files_index_and_rev(tmp_path):
    repo = git_repo(tmp_path / "r", {"a.txt": "a\n", "dir/ü b.py": "x\n"})
    first = _git.head(repo)
    commit(repo, {"a.txt": None, "c.txt": "c\n"})
    assert _git.ls_files(repo) == ["c.txt", "dir/ü b.py"]
    assert _git.ls_files(repo, first) == ["a.txt", "dir/ü b.py"]


def test_ls_candidates_skips_ignored(tmp_path):
    repo = git_repo(
        tmp_path / "r",
        {".gitignore": "/ignored/\n", "docs/wiki/repo-wiki.yaml": "lang: en\n"},
    )
    (repo / "other").mkdir()
    (repo / "other/repo-wiki.yaml").write_text("lang: en\n")  # untracked, not ignored
    (repo / "ignored").mkdir()
    (repo / "ignored/repo-wiki.yaml").write_text("lang: en\n")
    (repo / "x-repo-wiki.yaml").write_text("")
    assert _git.ls_candidates(repo, "repo-wiki.yaml") == [
        "docs/wiki/repo-wiki.yaml",
        "other/repo-wiki.yaml",
    ]


def test_blob_reader(tmp_path):
    binary = bytes(range(256)) * 3
    repo = git_repo(tmp_path / "r", {"a b.txt": "héllo\n"})
    (repo / "bin.dat").write_bytes(binary)
    (repo / "empty").write_bytes(b"")
    first = commit(repo, {"dir/x.txt": "x\n"})
    commit(repo, {"a b.txt": "second\n"})
    with _git.BlobReader(repo) as reader:
        assert reader.read(first, "a b.txt") == "héllo\n".encode()
        assert reader.read("HEAD", "a b.txt") == b"second\n"
        assert reader.read("HEAD", "bin.dat") == binary
        assert reader.read("HEAD", "empty") == b""
        assert reader.read("HEAD", "missing") is None
        assert reader.read("HEAD", "missing with space") is None
        assert reader.read("0" * 40, "a b.txt") is None
        assert reader.read("HEAD", "dir") is None  # a tree, not a blob
        for _ in range(200):
            assert reader.read("HEAD", "dir/x.txt") == b"x\n"
    with pytest.raises(_git.GitError), _git.BlobReader(repo) as reader:
        reader.read("HEAD", "a\nb")


def test_blob_reader_read_many_pipelines_in_order(tmp_path):
    big = "line\n" * 200_000  # larger than any pipe buffer
    files = {f"f{i:04d}.txt": f"{i}\n" for i in range(3000)}
    repo = git_repo(tmp_path / "r", dict(files, **{"big.txt": big}))
    paths = ["big.txt", "missing", "f0001.txt", *files]
    with _git.BlobReader(repo) as reader:
        got = list(reader.read_many("HEAD", paths))
        assert [p for p, _ in got] == paths
        assert got[0][1] == big.encode() and got[1][1] is None and got[2][1] == b"1\n"
        assert reader.read("HEAD", "f0002.txt") == b"2\n"  # still usable afterwards
    with _git.BlobReader(repo) as reader:
        stream = reader.read_many("HEAD", paths)
        next(stream)
        stream.close()  # abandoned mid-stream: must not hang


def test_diff_name_status_rename_and_glob(tmp_path):
    body = "".join(f"line {i}\n" for i in range(40))
    repo = git_repo(
        tmp_path / "r",
        {"src/a.py": body, "src/deep/b.py": "b\n", "src/gone.py": "g\n", "docs/x.md": "x\n"},
    )
    old = _git.head(repo)
    _sh(repo, "mv", "src/a.py", "src/renamed.py")
    new = commit(
        repo,
        {"src/deep/b.py": "b2\n", "src/gone.py": None, "src/new.py": "n\n", "docs/x.md": "y\n"},
    )
    changes = _git.diff_name_status(repo, old, new, [])
    assert sorted(changes) == [
        ("A", "src/new.py", None),
        ("D", "src/gone.py", None),
        ("M", "docs/x.md", None),
        ("M", "src/deep/b.py", None),
        ("R", "src/a.py", "src/renamed.py"),
    ]
    assert sorted(_git.diff_name_status(repo, old, new, ["src/*.py"])) == [
        ("A", "src/new.py", None),
        ("D", "src/gone.py", None),
        ("R", "src/a.py", "src/renamed.py"),
    ]
    assert _git.diff_name_status(repo, old, new, ["src/**/b.py"]) == [
        ("M", "src/deep/b.py", None)
    ]
    assert _git.diff_name_status(repo, old, new, ["docs"]) == [("M", "docs/x.md", None)]
    assert _git.diff_name_status(repo, new, new, []) == []


def test_log_name_only(tmp_path):
    repo = git_repo(tmp_path / "r", {"a b.txt": "a\n", "dir/ü/x y.py": "x\n"})
    commit(repo, {}, "empty")
    commit(repo, {"a b.txt": "b\n", "z": "z\n"})
    commit(repo, {"dir/ü/x y.py": None})
    assert _git.log_name_only(repo, 10) == [
        ["dir/ü/x y.py"],
        ["a b.txt", "z"],
        [],
        ["a b.txt", "dir/ü/x y.py"],
    ]
    assert _git.log_name_only(repo, 2) == [["dir/ü/x y.py"], ["a b.txt", "z"]]


def test_check_ignore(tmp_path):
    repo = git_repo(tmp_path / "r", {".gitignore": "/api/\n*.log\n"})
    (repo / "api").mkdir()
    assert _git.check_ignore(repo, "api")
    assert _git.check_ignore(repo, "x/y.log")
    assert not _git.check_ignore(repo, "worker")
    assert not _git.check_ignore(repo, "src/api")
