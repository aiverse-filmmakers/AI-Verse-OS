"""3A.12: isolated REAL Codex stable CLI smoke gate, GitHub Actions only.

This is not part of the installed OS or a recording implementation.
Run only inside the immutable-image, no-network CI container after verifying
the official release archive SHA-256. No Codex model, user prompts, tokens,
historical sessions or app-server thread/start or turn/start are used.

A schema match and valid initialize response do not authenticate user events,
grant OS consent, or prove a complete/authorized archived conversation.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

VERSION = "0.167.0"
TAG = "rust-v0.167.0"
MAX_JSONL = 65_536
# Generated v2 JSON schema source blobs from the SAME official release tag.
# Git object IDs of generated JSON schemas, not release signatures.
EXPECTED_BLOBS = {
    "ThreadStartParams": "5164caf6a208e4e0aa1d21baff108df8430c9d54",
    "ThreadStartResponse": "4dd9cb7744d7528e72eaf0bef273678ab40b2f43",
    "TurnStartParams": "d299d318ded151f436f19eb6445f47fedeae2867",
    "TurnStartResponse": "de6e2e5c3d2b5eb9d946b59d330b387de9127d8b",
    "ItemStartedNotification": "6a367ee32f36b7429e2ed7ae9d7fc5511cdb7bcf",
    "ItemCompletedNotification": "93e26bfb3277dfe38a06599ff481d2a689c6c329",
    "TurnCompletedNotification": "b8b60e30025b31b7366c23012d2fe2df289c5138",
}


class RuntimeBlocked(Exception):
    """Safe fixed-message CI diagnostic. Never contains payloads or paths."""


def deny(message: str) -> None:
    raise RuntimeBlocked(message)


def private_env() -> dict[str, str]:
    home = Path("/scratch/home")
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    (home / ".codex").mkdir(mode=0o700, exist_ok=True)
    return {
        "HOME": str(home),
        "CODEX_HOME": str(home / ".codex"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "NO_COLOR": "1",
        "RUST_LOG": "off",
    }


def run_quiet(args: list[str], env: dict[str, str], *, timeout: int) -> None:
    try:
        subprocess.run(args, check=True, cwd="/scratch", env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=timeout)
    except (OSError, ValueError, subprocess.SubprocessError):
        deny("stable Codex CLI setup/schema generation failed")


def verify_schemas(schema_root: Path) -> None:
    # Only inspect freshly generated schema JSON from this pinned executable.
    loaded = {}
    for name, expected_sha in EXPECTED_BLOBS.items():
        paths = list(schema_root.rglob(name + ".json"))
        if len(paths) != 1 or paths[0].is_symlink():
            deny("stable runtime generated schema missing or ambiguous")
        path = paths[0]
        if not path.is_file() or not 1 <= path.stat().st_size <= 200_000:
            deny("stable runtime generated schema invalid")
        data = path.read_bytes()
        sha = hashlib.sha1(
            b"blob " + str(len(data)).encode("ascii") + b"\x00" + data
        ).hexdigest()
        if sha != expected_sha:
            deny("runtime and official same-tag generated schema differ")
        try:
            loaded[name] = json.loads(data.decode("utf-8"))
        except (UnicodeError, ValueError):
            deny("stable runtime schema cannot be parsed")
    for name, clock in (
        ("ItemStartedNotification", "startedAtMs"),
        ("ItemCompletedNotification", "completedAtMs"),
    ):
        schema = loaded[name]
        if not {"item", "threadId", "turnId", clock} <= set(
            schema.get("required", ())
        ):
            deny("stable runtime lifecycle timestamp contract changed")
        if len(schema.get("definitions", {}).get("ThreadItem", {}).get("oneOf", [])) != 19:
            deny("stable runtime ThreadItem coverage shape changed")


def send(proc: subprocess.Popen[bytes], msg: dict) -> None:
    try:
        wire = json.dumps(msg, ensure_ascii=True, separators=(",", ":")).encode() + b"\n"
        if len(wire) > 4096:
            deny("CI initialization request oversized")
        proc.stdin.write(wire)
        proc.stdin.flush()
    except (OSError, ValueError, BrokenPipeError, AttributeError):
        deny("real App Server CI initialization pipe failed")


def read_matching(proc: subprocess.Popen[bytes], request_id: int,
                  pending: bytearray, *, timeout: float = 12.0,
                  allow_startup_notifications: bool = False) -> dict:
    end = time.monotonic() + timeout
    count = 0
    skipped = 0
    while time.monotonic() < end:
        if b"\n" in pending:
            frame, _, trailing = pending.partition(b"\n")
            pending[:] = trailing
            if not 1 <= len(frame) <= MAX_JSONL:
                deny("real App Server returned an invalid JSONL frame")
            try:
                message = json.loads(frame.decode("utf-8"))
            except (ValueError, UnicodeError):
                deny("real App Server returned non-JSON protocol bytes")
            if not isinstance(message, dict):
                deny("real App Server returned nonobject protocol frame")
            if message.get("id") == request_id:
                return message
            # The pinned Codex source emits configuration and other startup
            # notifications after initialized. They are not RPC responses,
            # a user conversation, or proof of recorded chat coverage.
            # Never swallow thread, turn, item or server-request events.
            method = message.get("method")
            if (allow_startup_notifications and "id" not in message
                    and isinstance(method, str) and len(method) <= 96
                    and not method.startswith((
                        "thread/", "turn/", "item/", "serverRequest/"
                    )) and isinstance(message.get("params"), dict)):
                skipped += 1
                if skipped > 8:
                    deny("real App Server sent too many unsolicited startup notifications")
                continue
            deny("real App Server sent unexpected protocol message")
        if proc.poll() is not None:
            deny("real App Server exited before responding")
        remain = end - time.monotonic()
        if remain <= 0:
            break
        try:
            ready, _, _ = select.select([proc.stdout], [], [], remain)
            if not ready:
                break
            chunk = os.read(proc.stdout.fileno(), 4096)
        except (OSError, ValueError):
            deny("real App Server stdout unavailable")
        if not chunk:
            deny("real App Server closed stdout unexpectedly")
        pending.extend(chunk)
        count += len(chunk)
        if count > MAX_JSONL * 3:
            deny("real App Server stdout over budget")
    deny("real App Server initialization timed out")


def handshake(binary: str, env: dict[str, str]) -> None:
    process = None
    try:
        process = subprocess.Popen(
            [binary, "app-server", "--listen", "stdio://"],
            cwd="/scratch", env=env, shell=False,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True,
        )
        pending = bytearray()
        send(process, {"id": 1, "method": "initialize",
                       "params": {"clientInfo": {
                           "name": "aiverse_persistent_chats_ci",
                           "title": "AI-Verse Persistent Chats isolated CI",
                           "version": "0.0.0-test",
                       }}})
        result = read_matching(process, 1, pending)
        if "error" in result or not isinstance(result.get("result"), dict):
            deny("real App Server initialize was not accepted")
        # The real server must be running, owned by our Popen handle, with
        # no network, no auth, no thread, no turn, no user text.
        if process.poll() is not None:
            deny("real App Server exited after initialize")
        send(process, {"method": "initialized"})
        # Prove the session recognizes repeated initialization as invalid.
        send(process, {"id": 2, "method": "initialize", "params": {
            "clientInfo": {"name": "aiverse_persistent_chats_ci",
                           "title": "AI-Verse Persistent Chats isolated CI",
                           "version": "0.0.0-test"},
        }})
        duplicate = read_matching(
            process, 2, pending, allow_startup_notifications=True
        )
        if not isinstance(duplicate.get("error"), dict) or "result" in duplicate:
            deny("real App Server did not reject duplicate initialize")
    except RuntimeBlocked:
        raise
    except (OSError, ValueError, TypeError):
        deny("real App Server process lifecycle check refused")
    finally:
        if process is not None:
            try:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=3)
            except (OSError, subprocess.SubprocessError):
                deny("real App Server teardown could not be confirmed")
            finally:
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()


def main() -> None:
    if (len(sys.argv) != 2 or sys.argv[1] != "/test/codex"
            or os.environ.get("CODEX_CI_OFFLINE_CONTAINER") != "1"):
        deny("isolated runtime test may run only in offline CI container")
    binary = "/test/codex"
    if not Path(binary).is_file() or Path(binary).is_symlink():
        deny("pinned stable CLI executable unavailable")
    env = private_env()
    try:
        version = subprocess.run(
            [binary, "--version"], cwd="/scratch", env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=8, check=True,
        ).stdout.decode("utf-8", "strict")
    except (OSError, UnicodeError, ValueError, subprocess.SubprocessError):
        deny("stable Codex CLI version check failed")
    if VERSION not in version:
        deny("pinned release version does not match executable")
    schema_root = Path("/scratch/generated-schema")
    run_quiet([binary, "app-server", "generate-json-schema",
               "--out", str(schema_root)], env, timeout=25)
    verify_schemas(schema_root)
    handshake(binary, env)
    print("PASS: official stable Codex runtime, 7 matching release schemas, "
          "no-token stdio initialization, duplicate refusal, clean teardown")
    print("BLOCKED: thread/turn execution, user data, archive writes, consent "
          "and real-host production admission")


if __name__ == "__main__":
    try:
        main()
    except RuntimeBlocked as exc:
        print("FAIL: " + str(exc), file=sys.stderr)
        sys.exit(1)
