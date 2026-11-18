#!/usr/bin/env python3
"""Guard: text mode file and subprocess calls must name their encoding.

Without an explicit encoding Python uses the machine's own code page. On
Windows that turns Romanian and other accented letters into garbage or a
crash, and it makes hashes of the same note differ between machines. This
test reads every tracked Python file and fails when a text mode open(),
io.open(), codecs.open(), os.fdopen(), Path.open(), read_text(), write_text(),
tempfile file, or text mode subprocess call has no encoding.

Binary mode calls are fine. A call that passes **kwargs is skipped because the
encoding may be inside it.
"""
from __future__ import annotations

import ast
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "__pycache__", "node_modules"}
SUBPROCESS_NAMES = {"run", "check_output", "check_call", "call", "Popen"}
TEMP_NAMES = {"NamedTemporaryFile", "TemporaryFile", "SpooledTemporaryFile"}
MODE_LIKE = re.compile(r"^[rwxabt+U]{1,4}$")


def _keyword(call, name):
    for item in call.keywords:
        if item.arg == name:
            return item
    return None


def _mode(call, position):
    if len(call.args) > position:
        return call.args[position]
    item = _keyword(call, "mode")
    return item.value if item is not None else None


def _is_binary(mode):
    return isinstance(mode, ast.Constant) and isinstance(mode.value, str) and "b" in mode.value


def _truthy(node):
    return not (isinstance(node, ast.Constant) and not node.value)


def _has_encoding(call, positional_index):
    return _keyword(call, "encoding") is not None or len(call.args) > positional_index


def flag(call):
    """Return the name of the offending call, or None."""
    if any(item.arg is None for item in call.keywords):
        return None
    func = call.func
    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
    owner = func.value.id if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) else None
    if name == "read_text":
        return None if _has_encoding(call, 0) else "read_text"
    if name == "write_text":
        return None if _has_encoding(call, 1) else "write_text"
    if name == "open" and owner == "os":
        return None  # os.open is a file descriptor call
    if name == "open" and owner == "codecs":
        return None if _has_encoding(call, 2) else "codecs.open"
    if name == "open" and owner == "io" or (name == "open" and isinstance(func, ast.Name)):
        if _is_binary(_mode(call, 1)):
            return None
        return None if _has_encoding(call, 3) else name
    if name == "open" and isinstance(func, ast.Attribute):
        # Path.open(mode, buffering, encoding). Other .open() methods (zip
        # members, urls) are binary or take a name first, so only a call that
        # looks like a text mode Path.open is flagged.
        mode = _mode(call, 0)
        looks_like_path_open = (
            (mode is None and not call.args)
            or (isinstance(mode, ast.Constant) and isinstance(mode.value, str) and bool(MODE_LIKE.match(mode.value)))
        )
        if not looks_like_path_open or _is_binary(mode):
            return None
        return None if _has_encoding(call, 2) else "Path.open"
    if name == "fdopen" and owner == "os":
        if _is_binary(_mode(call, 1)):
            return None
        return None if _has_encoding(call, 3) else "os.fdopen"
    if name in TEMP_NAMES:
        mode = _mode(call, 0)
        if mode is None or _is_binary(mode):
            return None  # default mode is binary
        return None if _has_encoding(call, 2) else name
    # Any call that asks for text output must name its encoding, whatever alias it goes through
    # (for example _RUN = subprocess.run), so this check does not look at the function name.
    process_like = name in SUBPROCESS_NAMES or any(
        _keyword(call, hint) is not None for hint in ("capture_output", "stdout", "stderr", "shell", "check")
    )
    if process_like:
        for option in ("text", "universal_newlines"):
            item = _keyword(call, option)
            if item is not None and _truthy(item.value):
                return None if _keyword(call, "encoding") is not None else f"text call {name}"
    return None


def bare_text_calls(source):
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call):
            label = flag(node)
            if label:
                found.append((node.lineno, label))
    return sorted(found)


def python_files():
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "*.py"],
            capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout.split("\n")
        files = [ROOT / item for item in out if item]
    except (OSError, subprocess.CalledProcessError):
        files = sorted(ROOT.rglob("*.py"))
    return [path for path in files if not SKIP_DIRS.intersection(path.relative_to(ROOT).parts)]


class TextEncodingLintTests(unittest.TestCase):
    def test_scanner_flags_bare_text_calls(self):
        bad = (
            'open("a")\n'
            'open("a", "w")\n'
            'io.open("a")\n'
            'codecs.open("a", "r")\n'
            'p.open()\n'
            'p.open("w")\n'
            'p.read_text()\n'
            'p.read_text(errors="ignore")\n'
            'p.write_text("x")\n'
            'os.fdopen(fd, "r+")\n'
            'tempfile.NamedTemporaryFile("w")\n'
            'tempfile.NamedTemporaryFile(mode="w+", delete=False)\n'
            'subprocess.run(["x"], text=True)\n'
            'subprocess.Popen(["x"], universal_newlines=True)\n'
            'check_output(["x"], text=True)\n'
        )
        self.assertEqual(len(bare_text_calls(bad)), 16)

    def test_scanner_accepts_explicit_or_binary(self):
        good = (
            'open("a", encoding="utf-8")\n'
            'open("a", "r", -1, "utf-8")\n'
            'open("a", "rb")\n'
            'open("a", mode="wb")\n'
            'io.open("a", "rb")\n'
            'codecs.open("a", "r", "utf-8")\n'
            'p.open("rb")\n'
            'p.open("w", encoding="utf-8")\n'
            'archive.open("member.txt")\n'
            'p.read_bytes()\n'
            'p.read_text(encoding="utf-8")\n'
            'p.read_text("utf-8")\n'
            'p.write_text("x", encoding="utf-8")\n'
            'p.write_text("x", "utf-8")\n'
            'os.open("a", 0)\n'
            'os.fdopen(fd, "wb")\n'
            'os.fdopen(fd, "r+", encoding="utf-8")\n'
            'tempfile.NamedTemporaryFile()\n'
            'tempfile.NamedTemporaryFile("wb")\n'
            'tempfile.NamedTemporaryFile("w", encoding="utf-8")\n'
            'tempfile.TemporaryDirectory()\n'
            'subprocess.run(["x"], capture_output=True)\n'
            'subprocess.run(["x"], text=False)\n'
            'subprocess.run(["x"], text=True, encoding="utf-8")\n'
            'subprocess.run(["x"], **options)\n'
        )
        self.assertEqual(bare_text_calls(good), [])

    def test_no_bare_text_calls_in_repository(self):
        problems = []
        for path in python_files():
            source = path.read_text(encoding="utf-8")
            for line, label in bare_text_calls(source):
                problems.append(f"{path.relative_to(ROOT)}:{line} {label}() without encoding")
        self.assertEqual(problems, [], 'Add encoding="utf-8" to:\n' + "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
