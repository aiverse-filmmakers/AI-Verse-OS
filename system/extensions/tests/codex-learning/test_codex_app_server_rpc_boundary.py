"""3A.13: no-host/no-token ownership classifier regression tests.

Tests only the parser from the offline CI-only Codex transport test.
No Codex binary, credentials, archived chats or client connection.
"""
import importlib.util
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
source = HERE / "test_codex_real_app_server_ci.py"
spec = importlib.util.spec_from_file_location("_codex_ci_rpc_ownership", source)
rpc = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rpc
spec.loader.exec_module(rpc)


class ReadOnlyRealProtocolOwnershipTests(unittest.TestCase):
    def refused(self, message, *, request_id=3, allow_startup=False):
        with self.assertRaises(rpc.RuntimeBlocked) as caught:
            rpc.classify_rpc_frame(
                message, request_id,
                allow_startup_notifications=allow_startup,
            )
        self.assertNotIn("SECRET_FIXTURE_TEXT", str(caught.exception))

    def test_exact_parent_owned_success_and_error_are_distinct(self):
        self.assertEqual(
            rpc.classify_rpc_frame(
                {"id": 3, "result": {"config": {}, "origins": {}}}, 3
            ), "response"
        )
        self.assertEqual(
            rpc.classify_rpc_frame(
                {"id": 3, "error": {"code": -32600}}, 3
            ), "response"
        )

    def test_unowned_id_and_id_reuse_are_refused(self):
        for value in (1, 2, 4, -1, "3", True, False, None, 3.0, [],
                      {"unknown": "SECRET_FIXTURE_TEXT"}):
            with self.subTest(value=repr(value)):
                self.refused({"id": value, "result": {}}, request_id=3)
        self.refused({"id": 3, "result": {}}, request_id=4)
        self.refused({"id": 3, "result": {}}, request_id=True)

    def test_rpc_reply_must_be_unambiguous_not_server_request(self):
        for message in (
            {"id": 3},
            {"id": 3, "result": {}, "error": {}},
            {"id": 3, "error": "SECRET_FIXTURE_TEXT"},
            {"id": 3, "method": "run/tool", "result": {}},
            {"id": 3, "method": "config/read", "params": {}},
            {"id": 3, "result": {}, "jsonrpc": "1.0"},
            {"result": {}},
            {"id": 3, "result": {}, "jsonrpc": None},
            [],
        ):
            with self.subTest(message=repr(message)[:30]):
                self.refused(message)

    def test_chat_events_are_never_accepted_as_startup_or_response(self):
        for method in (
            "thread/started", "thread/resumed",
            "turn/started", "turn/completed",
            "item/started", "item/completed",
            "serverRequest/tool",
        ):
            with self.subTest(method=method):
                self.refused(
                    {"method": method, "params": {
                        "text": "SECRET_FIXTURE_TEXT",
                    }}, allow_startup=True,
                )

    def test_only_bounded_nonchat_notifications_may_be_ignored(self):
        warning = {"method": "config/warning", "params": {
            "details": "SECRET_FIXTURE_TEXT",
        }}
        self.refused(warning)
        self.assertEqual(rpc.classify_rpc_frame(
            warning, 3, allow_startup_notifications=True
        ), "startup_notification")
        for obj in (
            {"method": "config/warning", "params": []},
            {"method": "config/warning", "params": {}, "result": {}},
            {"method": "config/warning", "params": {}, "error": {}},
            {"method": "config/warning", "params": {}, "id": 1},
            {"method": "config/warning", "params": {}, "jsonrpc": "1.0"},
            {"method": "a" * 97, "params": {}},
        ):
            with self.subTest(obj=repr(obj)[:35]):
                self.refused(obj, allow_startup=True)

    def test_no_implicit_authority_from_parent_correlation(self):
        reply = {"id": 3, "result": {"config": {}, "origins": {}}}
        self.assertEqual(
            rpc.classify_rpc_frame(reply, 3), "response",
        )
        # The classifier has no host-attestation, scope or consent result.
        self.assertFalse(hasattr(rpc, "grant_real_archive"))
        self.assertFalse(hasattr(rpc, "capture_chat_history"))


if __name__ == "__main__":
    unittest.main()
