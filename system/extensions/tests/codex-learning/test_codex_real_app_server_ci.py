"""3A.12: isolated REAL Codex stable CLI smoke gate, GitHub Actions only.

This is not part of the installed OS or a recording implementation.
Run only inside the immutable-image, no-network CI container after verifying
the official release archive SHA-256. No Codex model, user prompts, tokens,
historical sessions or app-server turn/start are used. A later CI-only
phase may open EMPTY ephemeral threads without executing model turns.

A schema match and valid initialize response do not authenticate user events,
grant OS consent, or prove a complete/authorized archived conversation.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import time
import uuid
from typing import Callable

VERSION = "0.167.0"
TAG = "rust-v0.167.0"
MAX_JSONL = 65_536
# Generated v2 JSON schema source blobs from the SAME official release tag.
# Git object IDs of generated JSON schemas, not release signatures.
EXPECTED_BLOBS = {
    "ConfigReadParams": "db38089a5d2d1927b0dc0ea580ee009964ff45a1",
    "ConfigReadResponse": "66a190dfe6761eca2b3453262320db07f3f85ea4",
    "ThreadStartParams": "5164caf6a208e4e0aa1d21baff108df8430c9d54",
    "ThreadStartResponse": "4dd9cb7744d7528e72eaf0bef273678ab40b2f43",
    "ThreadStartedNotification": "a51b8d802baa289b948357903b930a57085f62bd",
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
    if "includeLayers" not in loaded["ConfigReadParams"].get("properties", {}):
        deny("stable runtime read-only configuration request changed")
    if not {"config", "origins"} <= set(
        loaded["ConfigReadResponse"].get("required", ())
    ):
        deny("stable runtime read-only configuration response changed")
    if not {"thread"} <= set(
        loaded["ThreadStartedNotification"].get("required", ())
    ):
        deny("stable runtime new-thread notification contract changed")
    if not {"thread", "cwd", "approvalPolicy", "sandbox"} <= set(
        loaded["ThreadStartResponse"].get("required", ())
    ):
        deny("stable runtime new-thread response contract changed")
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


def classify_rpc_frame(message: object, request_id: int, *,
                       allow_startup_notifications: bool = False) -> str:
    """Classify one CI-only frame without treating notifications as replies.

    This is deliberately a strict prospective request/response correlation
    check, not provenance or authorization for anything an OS might record.
    """
    if type(request_id) is not int or request_id < 1:
        deny("invalid parent-owned test request id")
    if not isinstance(message, dict):
        deny("real App Server returned nonobject protocol frame")
    if "jsonrpc" in message and message["jsonrpc"] != "2.0":
        deny("real App Server sent invalid JSON-RPC version")
    if "id" in message:
        if (type(message["id"]) is not int
                or message["id"] != request_id or "method" in message
                or ("result" in message) == ("error" in message)):
            deny("real App Server returned unowned or ambiguous RPC reply")
        if "error" in message and not isinstance(message["error"], dict):
            deny("real App Server returned invalid RPC error")
        return "response"
    method = message.get("method")
    if (allow_startup_notifications and isinstance(method, str)
            and 0 < len(method) <= 96
            and not method.startswith((
                "thread/", "turn/", "item/", "serverRequest/"
            )) and "result" not in message and "error" not in message
            and isinstance(message.get("params"), dict)):
        return "startup_notification"
    deny("real App Server sent unexpected protocol message")


def read_matching(proc: subprocess.Popen[bytes], request_id: int,
                  pending: bytearray, *, timeout: float = 12.0,
                  allow_startup_notifications: bool = False,
                  require_owned: Callable[[], None] | None = None) -> dict:
    end = time.monotonic() + timeout
    count = 0
    skipped = 0
    while time.monotonic() < end:
        if require_owned is not None:
            require_owned()
        if b"\n" in pending:
            frame, _, trailing = pending.partition(b"\n")
            pending[:] = trailing
            if not 1 <= len(frame) <= MAX_JSONL:
                deny("real App Server returned an invalid JSONL frame")
            try:
                message = json.loads(frame.decode("utf-8"))
            except (ValueError, UnicodeError):
                deny("real App Server returned non-JSON protocol bytes")
            classification = classify_rpc_frame(
                message, request_id,
                allow_startup_notifications=allow_startup_notifications,
            )
            if require_owned is not None:
                require_owned()
            if classification == "response":
                return message
            skipped += 1
            if skipped > 8:
                deny("real App Server sent too many unsolicited startup notifications")
            continue
        if proc.poll() is not None:
            deny("real App Server exited before responding")
        remain = end - time.monotonic()
        if remain <= 0:
            break
        try:
            ready, _, _ = select.select(
                [proc.stdout], [], [],
                min(remain, 0.2) if require_owned is not None else remain,
            )
            if require_owned is not None:
                require_owned()
            if not ready:
                if require_owned is not None:
                    continue
                break
            chunk = os.read(proc.stdout.fileno(), 4096)
            if require_owned is not None:
                require_owned()
        except (OSError, ValueError):
            deny("real App Server stdout unavailable")
        if not chunk:
            deny("real App Server closed stdout unexpectedly")
        pending.extend(chunk)
        count += len(chunk)
        if count > MAX_JSONL * 3:
            deny("real App Server stdout over budget")
    deny("real App Server initialization timed out")


def read_isolated_config(proc: subprocess.Popen[bytes], pending: bytearray,
                         *, request_id: int,
                         require_owned: Callable[[], None] | None = None) -> None:
    """Exercise real owned request ID routing with a sterile read-only RPC."""
    send(proc, {
        "id": request_id, "method": "config/read",
        "params": {"includeLayers": False},
    })
    reply = read_matching(
        proc, request_id, pending, allow_startup_notifications=True,
        require_owned=require_owned,
    )
    if ("error" in reply or not isinstance(reply.get("result"), dict)
            or not isinstance(reply["result"].get("config"), dict)
            or not isinstance(reply["result"].get("origins"), dict)):
        deny("real App Server sterile configuration read refused")


def validate_ephemeral_thread(thread: object, requested_cwd: str) -> str:
    """Verify ephemeral root identity. NEVER return capture authority.

    This test explicitly creates new empty threads, never resumes/forks or
    loads a historical transcript. A returned id cannot prove OS consent.
    """
    if not isinstance(thread, dict) or requested_cwd not in (
        "/scratch/workspace-alpha", "/scratch/workspace-beta"
    ):
        deny("invalid sterile ephemeral thread boundary")
    tid = thread.get("id")
    if not isinstance(tid, str) or len(tid) != 36:
        deny("real App Server returned invalid ephemeral root id")
    try:
        parsed = uuid.UUID(tid)
    except (ValueError, AttributeError):
        deny("real App Server returned invalid ephemeral root id")
    if parsed.version != 7 or str(parsed) != tid:
        deny("real App Server returned non-root thread id")
    if (thread.get("sessionId") != tid
            or thread.get("ephemeral") is not True
            or thread.get("cwd") != requested_cwd
            or thread.get("forkedFromId") is not None
            or thread.get("turns") != []
            or thread.get("preview") not in (None, "")):
        deny("real App Server ephemeral root changed scope or history")
    return tid


def classify_ephemeral_reply(frame: object, request_id: int,
                             requested_cwd: str) -> tuple[str, str | None]:
    """Process an OS-intent-correlated, synthetic EMPTY thread handshake."""
    if not isinstance(frame, dict):
        deny("invalid sterile thread frame")
    if "jsonrpc" in frame and frame["jsonrpc"] != "2.0":
        deny("invalid sterile thread JSON-RPC version")
    if "id" in frame:
        if classify_rpc_frame(frame, request_id) != "response":
            deny("invalid parent-owned thread reply")
        result = frame.get("result")
        if not isinstance(result, dict):
            deny("real App Server refused sterile thread creation")
        return "response", validate_ephemeral_thread(
            result.get("thread"), requested_cwd
        )
    if frame.get("method") == "thread/started":
        if ("result" in frame or "error" in frame
                or not isinstance(frame.get("params"), dict)):
            deny("invalid sterile thread notification envelope")
        return "started", validate_ephemeral_thread(
            frame["params"].get("thread"), requested_cwd
        )
    if classify_rpc_frame(
        frame, request_id, allow_startup_notifications=True
    ) == "startup_notification":
        return "startup", None
    deny("unexpected sterile thread protocol event")


def next_ephemeral_frame(proc: subprocess.Popen[bytes], pending: bytearray,
                         deadline: float) -> dict:
    """Bounded line reader; never dumps host frames in CI logs."""
    total_bytes = 0
    while time.monotonic() < deadline:
        if b"\n" in pending:
            line, _, remainder = pending.partition(b"\n")
            pending[:] = remainder
            if not 1 <= len(line) <= MAX_JSONL:
                deny("real App Server sent oversized sterile thread frame")
            try:
                def no_duplicate(pairs):
                    row = {}
                    for key, value in pairs:
                        if key in row:
                            deny("duplicate field in sterile thread frame")
                        row[key] = value
                    return row
                frame = json.loads(line.decode("utf-8", "strict"),
                                   object_pairs_hook=no_duplicate,
                                   parse_constant=lambda _: deny("invalid JSON number"))
            except (ValueError, UnicodeError, TypeError):
                deny("real App Server returned malformed thread frame")
            if not isinstance(frame, dict):
                deny("real App Server returned nonobject thread frame")
            return frame
        if len(pending) > MAX_JSONL:
            deny("real App Server exceeded sterile thread frame budget")
        if proc.poll() is not None:
            deny("real App Server terminated during sterile thread check")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            ready, _, _ = select.select([proc.stdout], [], [], remaining)
            if not ready:
                break
            chunk = os.read(proc.stdout.fileno(), 4096)
        except (OSError, ValueError):
            deny("real App Server sterile thread pipe unavailable")
        if not chunk:
            deny("real App Server sterile thread stream truncated")
        pending.extend(chunk)
        total_bytes += len(chunk)
        if total_bytes > MAX_JSONL * 8:
            deny("real App Server sterile thread stream over budget")
    deny("real App Server sterile thread response timed out")


def probe_empty_ephemeral_thread(proc: subprocess.Popen[bytes],
                                 pending: bytearray, *,
                                 request_id: int, requested_cwd: str) -> str:
    """Issue only ephemeral thread/start, never turn/start or model input."""
    if type(request_id) is not int or request_id not in (5, 6):
        deny("invalid parent ephemeral thread request id")
    if requested_cwd not in (
        "/scratch/workspace-alpha", "/scratch/workspace-beta"
    ):
        deny("unowned sterile thread directory")
    send(proc, {
        "id": request_id,
        "method": "thread/start",
        "params": {
            "cwd": requested_cwd,
            "ephemeral": True,
            "approvalPolicy": "never",
            "sandbox": "read-only",
        },
    })
    bound_response = None
    bound_started = None
    startup = 0
    deadline = time.monotonic() + 15.0
    for _ in range(18):
        frame = next_ephemeral_frame(proc, pending, deadline)
        kind, thread_id = classify_ephemeral_reply(
            frame, request_id, requested_cwd
        )
        if kind == "response":
            if bound_response is not None:
                deny("duplicate sterile thread response")
            bound_response = thread_id
        elif kind == "started":
            if bound_started is not None:
                deny("duplicate sterile thread notification")
            bound_started = thread_id
        else:
            startup += 1
            if startup > 8:
                deny("too many unrelated sterile thread notices")
        if bound_response is not None and bound_started is not None:
            if bound_response != bound_started:
                deny("sterile thread response and notification disagree")
            return bound_response
    deny("sterile thread lifecycle did not complete")


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
        # Both calls are strictly read-only, use distinct parent-owned IDs,
        # and execute in a private, empty, offline container.
        read_isolated_config(process, pending, request_id=3)
        read_isolated_config(process, pending, request_id=4)
        # Two empty, distinct, ephemeral CI-only roots. No messages, no turns.
        for segment in ("workspace-alpha", "workspace-beta"):
            (Path("/scratch") / segment).mkdir(mode=0o700, exist_ok=False)
        alpha = probe_empty_ephemeral_thread(
            process, pending, request_id=5,
            requested_cwd="/scratch/workspace-alpha",
        )
        beta = probe_empty_ephemeral_thread(
            process, pending, request_id=6,
            requested_cwd="/scratch/workspace-beta",
        )
        if alpha == beta:
            deny("real App Server reused an ephemeral thread across scopes")
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
    print("PASS: official stable Codex runtime, 10 matching release schemas, "
          "no-token stdio initialization, duplicate refusal, two owner-correlated read-only RPCs, two isolated empty ephemeral threads, clean teardown")
    print("BLOCKED: model turns, user data, archive writes, consent "
          "and real-host production admission")


if __name__ == "__main__":
    try:
        main()
    except RuntimeBlocked as exc:
        print("FAIL: " + str(exc), file=sys.stderr)
        sys.exit(1)
