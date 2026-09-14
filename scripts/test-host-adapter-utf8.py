#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ADAPTER = Path(__file__).with_name("ai_verse_host_adapter.py")


def load_adapter():
    spec = importlib.util.spec_from_file_location("aiverse_os_host_utf8_test", ADAPTER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class HostAdapterUtf8Tests(unittest.TestCase):
    def test_json_subprocess_uses_utf8(self):
        module = load_adapter()
        completed = subprocess.CompletedProcess(["fixture"], 0, '{"ok":true}', "")
        with patch.object(module.subprocess, "run", return_value=completed) as run:
            result = module._run_json(["fixture"], {"text": "Direcție"}, "fixture")
        self.assertTrue(result["ok"])
        self.assertEqual(run.call_args.kwargs["encoding"], "utf-8")
        self.assertTrue(run.call_args.kwargs["text"])

    def test_current_context_resolver_uses_utf8(self):
        module = load_adapter()
        with tempfile.TemporaryDirectory() as tmp:
            host = module.OSFourComponentHost.__new__(module.OSFourComponentHost)
            host.root = Path(tmp)
            payload = {
                "scope": "workspace:alpha",
                "direction_owner": "os",
                "current_context": "Direcție: continuă",
                "source": "fixture",
            }
            completed = subprocess.CompletedProcess(
                ["node"], 0, json.dumps(payload, ensure_ascii=False), ""
            )
            with patch.object(module.subprocess, "run", return_value=completed) as run:
                result = host.read_context("workspace:alpha")
            self.assertEqual(result["current_context"], "Direcție: continuă")
            self.assertEqual(run.call_args.kwargs["encoding"], "utf-8")
            self.assertTrue(run.call_args.kwargs["text"])


if __name__ == "__main__":
    unittest.main()
