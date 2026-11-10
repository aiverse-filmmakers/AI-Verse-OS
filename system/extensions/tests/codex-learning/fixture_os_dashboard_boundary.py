"""3A.18 read-only tests of existing OS/Dashboard authority *surfaces*.

This is a fixture, not an authentication service, capture adapter,
browser cookie reader, token verifier, or OS-origin consent issuer.

Official sources: Codex App Server stdio thread/turn/events, NIST 800-63B-4
session invalidation, OWASP deny by default/per-request checks.
Pinned Dashboard local-app-session.ts source may be audited in CI.
All production capture and Memory discovery remain unconditionally denied.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

DASHBOARD_COMMIT = "91aad66592ab43dfe2acaeff314ade93c63a7cef"
DASHBOARD_LOCAL_SESSION_BLOB = "299c9c46371f64deaf8899d6672970e015f3b975"
DETECTOR_SCHEMA = "ai-verse.workspace-infrastructure-status/v1"
DETECTOR_GENERATION = "workspace-id-slot-v1"
MAX_MANIFEST_BYTES = 131072
MAX_DETECTOR_OUTPUT = 150000
WORKSPACE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class HostBoundaryBlocked(ValueError):
    """Static errors, never browser session, path or message content."""


def _deny() -> None:
    raise HostBoundaryBlocked("unissued Persistent Chats host authority refused")


@dataclass(frozen=True)
class SurfaceAudit:
    """Presence of an implementation, not proof of a live authorized host."""

    verdict: str = "pinned_host_surface_present_not_capture_issuer"
    native_session_authenticated: bool = False
    dashboard_cookie_verified: bool = False
    os_consent_issued: bool = False
    scope_authorized_for_capture: bool = False
    host_event_origin_attested: bool = False
    complete_visible_messages_verified: bool = False
    archive_write_admitted: bool = False


def _git_blob_sha1(source: bytes) -> str:
    return hashlib.sha1(
        b"blob " + str(len(source)).encode("ascii") + b"\0" + source
    ).hexdigest()


def inspect_pinned_dashboard_source(source: bytes) -> SurfaceAudit:
    """Fail if the *audited source snapshot* drifts; never mint consent.

    Pinned source checks are drift alarms, not cryptographic session proofs
    and not a substitute for running the Dashboard's own dynamic tests.
    """
    if (type(source) is not bytes or not 1000 <= len(source) <= 100000
            or _git_blob_sha1(source) != DASHBOARD_LOCAL_SESSION_BLOB):
        _deny()
    try:
        code = source.decode("utf-8", "strict")
        marker = "const PAIRED_BROWSER_METHODS=new Set(["
        allowed = code.split(marker, 1)[1].split("]);", 1)[0]
    except (UnicodeError, IndexError):
        _deny()
    methods = re.findall(r'"([a-z][a-z0-9._/-]{1,90})"', allowed)
    if (len(methods) < 8 or len(methods) != len(set(methods))
            or not {"workspace.get", "system.get",
                    "aiverse.gateway.run.create"} <= set(methods)):
        _deny()
    if any("codex" in method or "capture" in method or "archive" in method
           or "record" in method for method in methods):
        _deny()
    expected = (
        "ownerRegistry.bindingGeneration(this.scope.systemId)!==this.ownerGeneration",
        "current.dev===this.workspaceIdentity?.dev",
        "current.ino===this.workspaceIdentity?.ino",
        "this.sessionAbort.abort();",
        "rotateWorkspaceFromHost(workspaceId:string):void",
        "this.revoke();",
        "isAllowedBrowserStream(workspaceId:string):boolean",
        "isAuthorizedBrowser(req:IncomingMessage):boolean",
        "const COOKIE=\"aiverse_local_session\";",
        "private pairing=randomBytes(32).toString(\"base64url\");",
        "private sessionToken=randomBytes(32).toString(\"base64url\");",
    )
    if any(part not in code for part in expected):
        _deny()
    # A browser's paired cookie and session scope cannot attest host origin
    # or authorize AI-Verse Persistent Chats recording.
    return SurfaceAudit()


def check_synthetic_os_workspace(
    root: Path, workspace: str, detector: Path, *,
    node_executable: str = "node"
) -> SurfaceAudit:
    """Use the actual OS canonical read-only detector on a test workspace.

    This function must only be called on disposable synthetic roots. It
    verifies ID-slot consistency *not* operator authorization. No bearer
    token, UI grant or real Codex process is used or created.
    """
    if (os.name != "posix" or not isinstance(root, Path)
            or not isinstance(detector, Path) or not root.is_absolute()
            or not detector.is_absolute() or not isinstance(workspace, str)
            or not WORKSPACE_ID.fullmatch(workspace)
            or workspace == "_template" or node_executable != "node"):
        _deny()
    try:
        root_stat = root.lstat()
        directory = root / "workspaces" / workspace
        workspace_stat = directory.lstat()
        slots = root / "workspaces"
        slots_stat = slots.lstat()
        manifest = directory / "WORKSPACE.yaml"
        manifest_stat = manifest.lstat()
        if (any(not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid()
                or s.st_mode & 0o022 for s in (
                    root_stat, slots_stat, workspace_stat
                ))
                or not stat.S_ISREG(manifest_stat.st_mode)
                or manifest_stat.st_uid != os.getuid()
                or manifest_stat.st_mode & 0o022
                or manifest_stat.st_size > MAX_MANIFEST_BYTES
                or root.resolve(strict=True) != root
                or directory.resolve(strict=True) != directory):
            _deny()
        raw = manifest.read_text(encoding="utf-8", errors="strict")
        # The detector confirms id-slot identity and structural generation.
        # This additional explicit *synthetic* active-status check guards a
        # status change that the infrastructure detector does not examine.
        if len(re.findall(r"^status:[ \t]*active[ \t]*$", raw, re.M)) != 1:
            _deny()
        if any(s.startswith("status:") and
               not re.fullmatch(r"status:[ \t]*active[ \t]*", s)
               for s in raw.splitlines()):
            _deny()
        result = subprocess.run(
            ["node", str(detector), "detect", "--root", str(root)],
            cwd=str(root), env={"PATH": os.environ.get("PATH", "")},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=6, check=False,
        )
        if result.returncode or len(result.stdout) > MAX_DETECTOR_OUTPUT:
            _deny()
        doc = json.loads(result.stdout.decode("utf-8", "strict"))
        matching = [x for x in doc.get("workspaces", []) if
                    isinstance(x, dict) and x.get("id") == workspace]
        if (doc.get("schema_version") != DETECTOR_SCHEMA
                or doc.get("owner") != "ai-verse-os"
                or doc.get("state") != "current"
                or doc.get("current_generation") != DETECTOR_GENERATION
                or doc.get("mutated") is not False
                or doc.get("findings") != []
                or len(matching) != 1
                or matching[0].get("slot") != "workspaces/" + workspace
                or matching[0].get("state") != "current"
                or matching[0].get("generation") != DETECTOR_GENERATION):
            _deny()
        # No native launcher auth, no browser pairing, no OS UI consent.
        return SurfaceAudit(
            verdict="canonical_workspace_fixture_detected_not_capture_authority"
        )
    except HostBoundaryBlocked:
        raise
    except (OSError, ValueError, TypeError, KeyError, UnicodeError,
            subprocess.SubprocessError, RuntimeError, AttributeError):
        _deny()


def admit_real_host_capture(_audit=None, _claims=None) -> dict:
    return {"status": "blocked", "reason": "native host consent issuer not connected"}
