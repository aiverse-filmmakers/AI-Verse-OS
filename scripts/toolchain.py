"""Python twin of scripts/toolchain.mjs: which Node, Python and Git to run.

Private copies kept for AI-Verse OS first, then a tool already on the computer only
if it is recent enough. Never a bare command name, never a package manager.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

NAMES = {"node": (["node"], ["node.exe"]), "python": (["python3", "python"], ["python.exe"]), "git": (["git"], ["git.exe"])}
PRIVATE = {
    "node": (["node/bin/node"], ["node/node.exe"]),
    "python": (["python/bin/python3"], ["python/python.exe"]),
    "git": (["git/bin/git"], ["git/cmd/git.exe", "git/bin/git.exe"]),
}
_RUN = subprocess.run  # kept at import time so callers that stub subprocess.run cannot break version checks
DARWIN_SHIMS = {"/usr/bin/git", "/usr/bin/python3", "/usr/bin/python"}
_CACHE = {}
_DEV_TOOLS = []
DEFAULT_MINIMUM = {"node": "22.0.0", "python": "3.9.0", "git": "2.25.0"}  # same as system/toolchain/manifest.json (a test keeps them equal)
MANIFEST = Path(__file__).resolve().parent.parent / "system" / "toolchain" / "manifest.json"


def parse_version(text):
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", str(text or ""))
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)) if m else None


def toolchain_dir(env=None):
    env = os.environ if env is None else env
    return Path(env.get("AI_VERSE_TOOLCHAIN_DIR") or Path.home() / ".aiverse" / "toolchain")


def _minimums():
    """Oldest allowed versions. Test folders that copy only scripts/ have no manifest, so fall back to the built-in numbers."""
    try:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))["minimum"]
    except (OSError, ValueError, KeyError):
        return DEFAULT_MINIMUM


def clear_cache():
    _CACHE.clear()
    _DEV_TOOLS.clear()


def _developer_tools_installed():
    """Apple's /usr/bin shims pop up an install dialog unless the developer tools really exist."""
    if not _DEV_TOOLS:
        try:
            r = _RUN(["/usr/bin/xcode-select", "-p"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, shell=False)
            _DEV_TOOLS.append(r.returncode == 0 and bool(r.stdout.strip()))
        except (OSError, subprocess.SubprocessError):
            _DEV_TOOLS.append(False)
    return _DEV_TOOLS[0]


def _env_get(env, name):
    for k in env:
        if k.upper() == name.upper():
            return env[k]
    return None


def _version_of(file):
    try:
        r = _RUN([str(file), "--version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, shell=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_version(f"{r.stdout} {r.stderr}") if r.returncode == 0 else None


def resolve_tool(tool, env=None, platform=None):
    """Return the full path of the tool to run, or None."""
    env = os.environ if env is None else env
    platform = platform or sys.platform
    key = (tool, platform, _env_get(env, "PATH"), env.get("AI_VERSE_TOOLCHAIN_DIR"))
    if key not in _CACHE:
        _CACHE[key] = _resolve(tool, env, platform)
    return _CACHE[key]


def _resolve(tool, env, platform):
    win = platform == "win32"
    idx = 1 if win else 0
    minimum = parse_version(_minimums()[tool])
    candidates = [toolchain_dir(env).joinpath(*rel.split("/")) for rel in PRIVATE[tool][idx]]
    for d in str(_env_get(env, "PATH") or "").split(";" if win else ":"):
        # Windows Store stubs open the Store instead of running anything.
        if d and not (win and re.search(r"[\\/]WindowsApps([\\/]|$)", d, re.I)):
            candidates += [Path(d) / n for n in NAMES[tool][idx]]
    if tool == "python":
        candidates.append(Path(sys.executable))  # last resort: the interpreter already running this script
    for c in candidates:
        if c.is_file():
            if platform == "darwin" and str(c) in DARWIN_SHIMS and not _developer_tools_installed():
                continue
            v = _version_of(c)
            if v and v >= minimum:
                return str(c)
    return None


def tool_path(tool):
    found = resolve_tool(tool)
    if not found:
        raise FileNotFoundError(f"AI-Verse OS needs {tool}, and it was not found. Run the AI-Verse OS setup again.")
    return found
