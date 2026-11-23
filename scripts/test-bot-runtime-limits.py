#!/usr/bin/env python3
"""FL-08: a helper bot may only talk to https or this computer, with an approved password variable."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest

ADAPTER = Path(__file__).with_name("ai_verse_host_adapter.py")


def load_adapter():
    spec = importlib.util.spec_from_file_location("aiverse_os_bot_limits_test", ADAPTER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


MODULE = load_adapter()
HOST = MODULE.AIverseOSHost
BOTH = (
    ("temporary", HOST._temporary_worker_runtime),
    ("permanent", HOST._permanent_bot_runtime),
)


def runtime(endpoint="https://api.example.com/v1", **extra):
    value = {"adapter": "openai-compatible", "endpoint": endpoint, "model": "fixture-model"}
    value.update(extra)
    return value


class BotRuntimeLimitTests(unittest.TestCase):
    def test_https_and_local_addresses_are_accepted(self):
        for name, check in BOTH:
            for endpoint in (
                "https://api.example.com/v1",
                "http://localhost:11434/v1",
                "http://127.0.0.1:8080",
                "http://[::1]:8080/v1",
                "http://ollama.localhost:11434",
                "https://localhost/v1",
            ):
                with self.subTest(kind=name, endpoint=endpoint):
                    self.assertEqual(check(runtime(endpoint))["endpoint"], endpoint)

    def test_plain_http_to_the_internet_is_refused(self):
        for name, check in BOTH:
            for endpoint in (
                "http://api.example.com/v1",
                "http://10.0.0.5/v1",
                "http://127.0.0.1.evil.example/v1",
                "http://localhost.evil.example/v1",
                "http://169.254.169.254/latest",
            ):
                with self.subTest(kind=name, endpoint=endpoint):
                    with self.assertRaises(MODULE.AdapterError):
                        check(runtime(endpoint))

    def test_addresses_that_hide_the_real_host_are_refused(self):
        for name, check in BOTH:
            for endpoint in (
                "http://localhost@evil.example/v1",
                "https://user:pw@api.example.com/v1",
                "https://api.example.com:notaport/v1",
                "https:///v1",
                "ftp://api.example.com",
                "https://api.example.com/a b",
            ):
                with self.subTest(kind=name, endpoint=endpoint):
                    with self.assertRaises(MODULE.AdapterError):
                        check(runtime(endpoint))

    def test_only_approved_password_variables_are_accepted(self):
        for name, check in BOTH:
            with self.subTest(kind=name, ok=True):
                self.assertEqual(check(runtime(api_key_env="OPENAI_API_KEY"))["api_key_env"], "OPENAI_API_KEY")
            for handle in ("HOME", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "PATH", "openai_api_key", "", 5):
                with self.subTest(kind=name, handle=handle):
                    with self.assertRaises(MODULE.AdapterError):
                        check(runtime(api_key_env=handle))

    def test_no_password_variable_and_deterministic_still_work(self):
        for name, check in BOTH:
            with self.subTest(kind=name):
                self.assertNotIn("api_key_env", check(runtime()))
                self.assertEqual(check({"adapter": "deterministic"}), {"adapter": "deterministic"})


if __name__ == "__main__":
    unittest.main()
