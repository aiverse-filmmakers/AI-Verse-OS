"""3A.17 private, disposable v2 fixture persistence crash/restart tests.

No OS/Dashboard/Memory runtime, real Codex host, model, credential, hook,
human history or production archive writes. The producer emits only fixture
wire and hard-denies actual capture. Files exist only in per-test temp dirs.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "_3a17_disposable_v2_disk", HERE / "fixture_v2_disk_store.py",
)
store = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = store
spec.loader.exec_module(store)
from test_codex_app_server_archive_v2 import V2ArchiveFixtureContractTests


@unittest.skipUnless(os.name == "posix", "openat/linkat fixture needs POSIX")
class DisposableV2DiskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aiverse-3a17-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(strict=True)
        self.blob = V2ArchiveFixtureContractTests().generate()
        self.archive_id = "fixture-archive-8"

    def blocked(self, func):
        with self.assertRaises(store.DiskFixtureBlocked) as err:
            func()
        self.assertEqual(str(err.exception),
                         "private synthetic v2 disk fixture refused")
        self.assertNotIn(str(self.root), str(err.exception))
        self.assertNotIn("fixture prompt", str(err.exception))

    def publish(self):
        return store.publish_synthetic(self.root, self.archive_id, self.blob)

    def path(self):
        return self.root / (self.archive_id + ".synthetic-codex-v2.jsonl")

    def test_private_exact_readback_receipt_and_no_production_gate(self):
        receipt = self.publish()
        self.assertEqual(store.read_synthetic(self.root, self.archive_id, receipt),
                         self.blob)
        self.assertEqual(receipt.sha256, hashlib.sha256(self.blob).hexdigest())
        self.assertEqual(receipt.bytes, len(self.blob))
        self.assertFalse(receipt.real_host_authenticated)
        self.assertFalse(receipt.real_scope_authorized)
        self.assertFalse(receipt.os_consent_verified)
        self.assertFalse(receipt.production_archive_admitted)
        self.assertEqual(stat.S_IMODE(self.path().stat().st_mode), 0o600)
        self.assertEqual(self.path().stat().st_nlink, 1)
        self.assertEqual(store.admit_real_archive({"trusted": True})["status"],
                         "blocked")

    def test_existing_archive_never_overwritten_even_if_same_blob(self):
        receipt = self.publish()
        self.blocked(self.publish)
        self.assertEqual(
            store.read_synthetic(self.root, self.archive_id, receipt), self.blob
        )
        self.assertEqual(list(self.root.glob("*.synthetic-codex-v2.jsonl")),
                         [self.path()])

    def test_independent_process_restart_reopens_exact_fixture(self):
        receipt = self.publish()
        code = (
            "import hashlib,sys\n"
            "from pathlib import Path\n"
            "sys.path.insert(0,sys.argv[1])\n"
            "from fixture_v2_disk_store import FixtureReceipt,read_synthetic\n"
            "r=FixtureReceipt(sys.argv[3],int(sys.argv[4]),sys.argv[5])\n"
            "print(hashlib.sha256(read_synthetic(Path(sys.argv[2]),"
            "sys.argv[3],r)).hexdigest())\n"
        )
        run = subprocess.run(
            [sys.executable, "-c", code, str(HERE), str(self.root),
             self.archive_id, str(receipt.bytes), receipt.sha256],
            cwd=str(self.root), env={"PATH": os.environ.get("PATH", ""),
                                      "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True, text=True, timeout=12, check=True,
        )
        self.assertEqual(run.stdout.strip(), receipt.sha256)
        self.assertEqual(run.stderr, "")

    def test_changed_bytes_cannot_be_read_with_original_receipt(self):
        receipt = self.publish()
        with self.path().open("r+b") as f:
            f.seek(21)
            old = f.read(1)
            f.seek(21)
            f.write(b"A" if old != b"A" else b"B")
            f.flush()
            os.fsync(f.fileno())
        self.blocked(lambda: store.read_synthetic(
            self.root, self.archive_id, receipt,
        ))

    def test_truncation_and_wrong_receipt_refused(self):
        receipt = self.publish()
        self.blocked(lambda: store.read_synthetic(
            self.root, self.archive_id, replace(receipt, bytes=receipt.bytes-1)
        ))
        self.blocked(lambda: store.read_synthetic(
            self.root, self.archive_id,
            replace(receipt, os_consent_verified=True)
        ))
        self.path().write_bytes(self.blob[:50])
        self.blocked(lambda: store.read_synthetic(
            self.root, self.archive_id, receipt
        ))

    def test_unpublished_temp_file_never_counts_as_archive(self):
        (self.root / ".uncommitted-0000").write_bytes(self.blob)
        self.blocked(lambda: store.read_synthetic(
            self.root, self.archive_id,
            store.FixtureReceipt(
                self.archive_id, len(self.blob),
                hashlib.sha256(self.blob).hexdigest()
            )
        ))

    def test_interrupt_before_atomic_link_creates_no_final_file(self):
        with mock.patch.object(store.os, "link", side_effect=OSError("simulated")):
            self.blocked(self.publish)
        self.assertFalse(self.path().exists())
        self.assertFalse(list(self.root.glob(".uncommitted-*")))
        self.publish()
        self.assertTrue(self.path().exists())

    def test_interruption_after_atomic_link_preserves_committed_file(self):
        original = store.os.unlink
        once = {"called": False}

        def fail_first(name, *, dir_fd=None):
            if not once["called"]:
                once["called"] = True
                raise OSError("synthetic interruption after publication")
            return original(name, dir_fd=dir_fd)

        with mock.patch.object(store.os, "unlink", side_effect=fail_first):
            self.blocked(self.publish)
        self.assertTrue(self.path().exists())
        receipt = store.FixtureReceipt(
            self.archive_id, len(self.blob),
            hashlib.sha256(self.blob).hexdigest(),
        )
        self.assertEqual(
            store.read_synthetic(self.root, self.archive_id, receipt), self.blob
        )

    def test_racing_writers_never_replace_each_other(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            tasks = [pool.submit(self.publish) for _ in range(2)]
            results = []
            for task in tasks:
                try:
                    results.append(task.result(timeout=12))
                except store.DiskFixtureBlocked:
                    results.append(None)
        self.assertEqual(sum(x is not None for x in results), 1)
        winning = next(x for x in results if x is not None)
        self.assertEqual(
            store.read_synthetic(self.root, self.archive_id, winning), self.blob
        )

    def test_unsafe_symlink_target_and_symlink_root_refused(self):
        target = self.root / "source"
        target.write_bytes(self.blob)
        self.path().symlink_to(target)
        self.blocked(self.publish)
        self.path().unlink()
        linked_root = self.root.parent / (self.root.name + "-linked")
        linked_root.symlink_to(self.root, target_is_directory=True)
        self.addCleanup(lambda: linked_root.unlink(missing_ok=True))
        self.blocked(lambda: store.publish_synthetic(
            linked_root, self.archive_id, self.blob
        ))

    def test_nonprivate_root_and_linked_final_refused(self):
        mode = stat.S_IMODE(self.root.stat().st_mode)
        self.root.chmod(0o755)
        try:
            self.blocked(self.publish)
        finally:
            self.root.chmod(mode)
        receipt = self.publish()
        hardlink = self.root / "hardlink"
        os.link(self.path(), hardlink)
        self.blocked(lambda: store.read_synthetic(
            self.root, self.archive_id, receipt
        ))

    def test_invalid_blob_and_forged_flags_refused_without_writes(self):
        for attack in (
            b"", b"{}\n", self.blob[:100],
            self.blob.replace(b'"consent_verified":false',
                              b'"consent_verified":true', 1),
            self.blob.replace(b'"frame_count":4', b'"frame_count":5', 1),
            b"x" * (store.MAX_BYTES + 1),
        ):
            with self.subTest(size=len(attack)):
                self.blocked(lambda: store.publish_synthetic(
                    self.root, self.archive_id, attack
                ))
        self.assertFalse(self.path().exists())

    def test_bad_archive_id_and_scope_escaping_not_allowed(self):
        for bad in ("../archive", "archive/bad", "with.dot", "", "x" * 65, 5):
            with self.subTest(value=bad):
                self.blocked(lambda: store.publish_synthetic(
                    self.root, bad, self.blob
                ))
        self.assertFalse(list(self.root.glob("*.jsonl")))


if __name__ == "__main__":
    unittest.main()
