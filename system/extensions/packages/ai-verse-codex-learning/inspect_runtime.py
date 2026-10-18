"""Read-only hook discovery through the installed Codex protocol."""
import json
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import time

from bridge import DEFAULT_ROOT, ID


def inspect(root, config=None, proxy=False, codex=None):
    command = [codex or shutil.which("codex"), "app-server"]
    if proxy:
        command += ["proxy"]
    else:
        command += ["--stdio", "--enable", "hooks"]
        for value in config or []:
            command += ["-c", value]
    stderr = Path(root) / "runtime/reports/codex-learning/runtime-inspect.stderr"
    stderr.parent.mkdir(parents=True, exist_ok=True)
    with stderr.open("w") as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=errors, text=True, bufsize=1, cwd=root)
        selection = selectors.DefaultSelector()
        selection.register(process.stdout, selectors.EVENT_READ)
        def request(identity, method, params):
            process.stdin.write(json.dumps({"id": identity, "method": method, "params": params}) + "\n")
            process.stdin.flush()
            until = time.monotonic() + 25
            while time.monotonic() < until:
                if not selection.select(timeout=1):
                    if process.poll() is not None:
                        raise RuntimeError("Codex protocol process ended before replying")
                    continue
                line = process.stdout.readline()
                if not line:
                    raise RuntimeError("Codex protocol closed")
                value = json.loads(line)
                if value.get("id") == identity:
                    return value
            raise TimeoutError("Codex protocol response timeout")
        try:
            initialized = request(1, "initialize", {
                "clientInfo": {"name": "aiverse-qc", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True}})
            process.stdin.write(json.dumps({"method": "initialized", "params": {}}) + "\n")
            process.stdin.flush()
            hooks = request(2, "hooks/list", {"cwds": [str(root)]})
            layers = request(3, "config/read", {"cwd": str(root), "includeLayers": True})
            result = layers.get("result", {})
            # Exclude effective configuration and environment values; print source metadata only.
            sources = [{key: layer.get(key) for key in ["name", "source", "disabledReason", "disabled_reason"]}
                       for layer in result.get("layers", [])]
            return {"initialized": "result" in initialized, "hooks": hooks,
                    "config_layer_sources": sources}
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=3)


if __name__ == "__main__":
    if "--fixture" in sys.argv:
        from test_bridge import fixture
        temporary, root = fixture()
        try:
            subprocess.run(["git", "init", "--quiet", str(root)], check=True)
            subprocess.run([sys.executable, str(root / ".aiverse/extensions" / ID / "lifecycle.py"),
                            "--root", str(root), "install"], stdout=subprocess.DEVNULL, check=True)
            (root / ".codex/config.toml").write_text("# Local hook configuration layer.\n")
            print(json.dumps(inspect(root, ['projects."' + str(root) + '".trust_level="trusted"']), indent=2))
        finally:
            temporary.cleanup()
    else:
        print(json.dumps(inspect(DEFAULT_ROOT, proxy="--proxy" in sys.argv), indent=2))
