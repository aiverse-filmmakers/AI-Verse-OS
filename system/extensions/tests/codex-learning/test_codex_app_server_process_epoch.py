"""3A.24: disposable direct-child stdout lease and process epoch regressions.

Pure Linux CI synthetic tests. A real Codex binary is *not* launched here;
the separately verified pinned no-network test probes actual stable Codex.
No human chat, recording grant, archive, token, Memory or browser source.
"""
from __future__ import annotations

from dataclasses import replace
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "_aiverse_codex_3a24_offline_child",
    HERE / "test_codex_real_app_server_ci.py",
)
ci = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ci
spec.loader.exec_module(ci)


@unittest.skipUnless(sys.platform == "linux",
                     "owned pipe and /proc cwd contract is Linux CI only")
class DisposableRealChildEpochTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="aiverse-3a24-proc-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve(strict=True)
        self.alpha = self.root / "alpha"
        self.beta = self.root / "beta"
        self.alpha.mkdir(mode=0o700)
        self.beta.mkdir(mode=0o700)
        self.fence = ci.DisposableRealChildEpoch(
            (str(self.alpha), str(self.beta))
        )

    def start(self, cwd: Path):
        script = (
            "import json,sys\n"
            "for raw in sys.stdin:\n"
            " try:\n"
            "  obj=json.loads(raw)\n"
            "  data={'id':obj['id'],'result':{'config':{},'origins':{}}}\n"
            "  print(json.dumps(data,separators=(',',':')),flush=True)\n"
            " except (ValueError,KeyError):\n"
            "  break\n"
        )
        child = subprocess.Popen(
            [sys.executable, "-u", "-c", script],
            cwd=str(cwd), shell=False, close_fds=True, start_new_session=True,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={
                "PATH": os.environ.get("PATH", ""),
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )
        self.addCleanup(lambda: ci._stop_disposable_real_child(child))
        return child

    def blocked(self, action, exact=None):
        with self.assertRaises(ci.RuntimeBlocked) as caught:
            action()
        if exact is not None:
            self.assertEqual(str(caught.exception), exact)
        self.assertNotIn(str(self.root), str(caught.exception))

    def test_parent_pipe_reads_are_bounded_to_a_live_epoch(self):
        child = self.start(self.alpha)
        lease = self.fence.bind(child, str(self.alpha))
        self.fence.require(lease)
        ci.send(child, {"id": 42, "method": "test/read", "params": {}})
        result = ci.read_matching(
            child, 42, bytearray(),
            require_owned=lambda: self.fence.require(lease),
        )
        self.assertEqual(result.get("result"), {"config": {}, "origins": {}})
        self.fence.revoke()
        self.blocked(lambda: self.fence.require(lease),
                     "real CI child lease revoked or replaced")
        self.blocked(lambda: ci.read_matching(
            child, 43, bytearray(),
            require_owned=lambda: self.fence.require(lease),
        ), "real CI child lease revoked or replaced")

    def test_fast_revocation_blocks_old_pending_reply_even_if_parent_reads_late(self):
        child = self.start(self.alpha)
        lease = self.fence.bind(child, str(self.alpha))
        ci.send(child, {"id": 43, "method": "test/read", "params": {}})
        self.fence.revoke()
        self.blocked(lambda: ci.read_matching(
            child, 43, bytearray(),
            require_owned=lambda: self.fence.require(lease),
        ), "real CI child lease revoked or replaced")
        self.blocked(lambda: self.fence.bind(child, str(self.alpha)),
                     "real CI child process binding refused")

    def test_new_workspace_needs_new_process_after_old_child_exit(self):
        old = self.start(self.alpha)
        old_lease = self.fence.bind(old, str(self.alpha))
        self.fence.revoke()
        replacement = self.start(self.beta)
        self.blocked(lambda: self.fence.bind(replacement, str(self.beta)),
                     "real CI child process binding refused")
        ci._stop_disposable_real_child(old)
        fresh = self.fence.bind(replacement, str(self.beta))
        self.assertGreater(fresh.generation, old_lease.generation)
        self.blocked(lambda: self.fence.require(old_lease),
                     "real CI child lease revoked or replaced")
        self.fence.require(fresh)
        self.assertEqual(fresh.workspace, str(self.beta))
        self.fence.revoke()
        self.blocked(lambda: self.fence.require(fresh),
                     "real CI child lease revoked or replaced")

    def test_foreign_forged_or_mismatched_scope_is_rejected(self):
        child = self.start(self.alpha)
        self.blocked(lambda: self.fence.bind(child, str(self.beta)),
                     "real CI child changed physical workspace")
        lease = self.fence.bind(child, str(self.alpha))
        self.blocked(lambda: self.fence.require(
            replace(lease, generation=lease.generation + 1)
        ), "real CI child lease revoked or replaced")
        other = self.start(self.beta)
        self.blocked(lambda: self.fence.bind(other, str(self.beta)),
                     "real CI child process binding refused")

    def test_symlink_and_group_accessible_workspace_are_rejected(self):
        link = self.root / "linked"
        link.symlink_to(self.alpha, target_is_directory=True)
        child = self.start(self.alpha)
        self.blocked(lambda: ci.DisposableRealChildEpoch(
            (str(link), str(self.beta))
        ).bind(child, str(link)),
        "real CI child workspace identity refused")
        before = stat.S_IMODE(self.alpha.stat().st_mode)
        self.alpha.chmod(0o755)
        try:
            self.blocked(lambda: self.fence.bind(child, str(self.alpha)),
                         "real CI child workspace identity refused")
        finally:
            self.alpha.chmod(before)

    def test_exited_child_rejected_even_when_lease_object_unchanged(self):
        child = self.start(self.alpha)
        lease = self.fence.bind(child, str(self.alpha))
        ci._stop_disposable_real_child(child)
        self.blocked(lambda: self.fence.require(lease),
                     "real CI child lease revoked or replaced")
        self.fence.revoke()


if __name__ == "__main__":
    unittest.main()
