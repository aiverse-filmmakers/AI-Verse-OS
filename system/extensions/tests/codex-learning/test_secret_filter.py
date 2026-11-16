"""The secret filter catches the common real secret shapes, leaves ordinary prose alone, and stays fast."""
from __future__ import annotations

from pathlib import Path
import sys
import time
import unittest

PACKAGE = Path(__file__).resolve().parents[2] / "packages" / "ai-verse-codex-learning"
sys.path.insert(0, str(PACKAGE))
from bridge import SECRET, Refused, no_secrets

SECRETS = {
    "password": "password: hunter2",
    "password with is": "my password is hunter2",
    "assignment": "secret = abc12345xyz",
    "client secret": "client_secret: abcdef123456",
    "api key": "api-key=zzzzzz123456",
    "quoted token": 'token = "abcdef123456"',
    "openai key": "sk-" + "a1B2" * 8,
    "bearer": "Authorization: Bearer abc.def-ghi_123",
    "github token": "ghp_" + "a" * 30,
    "github fine grained": "github_pat_" + "A1b2" * 8,
    "aws access key": "AKIAIOSFODNN7EXAMPLE",
    "aws temporary key": "ASIAIOSFODNN7EXAMPLE",
    "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
    "slack token": "xoxb-1234567890-abcdefghij",
    "google key": "AIza" + "Sy" * 20,
    "env var": 'DB_PASSWORD="hunter2secret"',
    "json password": '{"password": "hunter2secret"}',
    "api key long": "api_key=abcdefghijk1",
    "secret long word": "secret = abcdefghijklmnop",
    "database url": "postgres://app:s3cretpw@db.example.com:5432/main",
    "pem": "-----BEGIN RSA PRIVATE KEY-----",
}

PROSE = [
    "Credential: Bogdan holds an MBA degree.",
    "Use token: abcdefg to see how tokens look.",
    "credentials: stored in the vault",
    "We discussed the secret: pricing strategy for Q3.",
    "We talked about the secret garden at the old house.",
    "The token economy worked well in that classroom.",
    "Meet at https://example.com/path/page tomorrow at ten.",
    "I keep a credential manager for the whole team.",
    "key: value pairs are easy to read.",
    "The sky is the limit, and the key point is timing.",
    "Email me at anna@example.com or open ftp://files.example.com/docs.",
    "Her private life is her own business.",
    "Use the AWS console to review the keys on the team page.",
]


class SecretFilterTests(unittest.TestCase):
    def test_each_secret_shape_is_caught(self):
        for name, sample in SECRETS.items():
            with self.subTest(name):
                self.assertTrue(SECRET.search(sample), name)
                self.assertTrue(SECRET.search(f"before {sample} after"), name)
                with self.assertRaises(Refused):
                    no_secrets({"text": sample})

    def test_secrets_inside_json_text_are_caught(self):
        for sample in ('{"password": "abcdef123456"}', '{"client_secret":"abcdef123456"}',
                       '{"note": "token = abcdef123456"}', '{"url": "mysql://u:pw99@host/db"}'):
            with self.subTest(sample):
                with self.assertRaises(Refused):
                    no_secrets({"text": sample})
                with self.assertRaises(Refused):
                    no_secrets(sample)

    def test_ordinary_sentences_are_not_flagged(self):
        for sentence in PROSE:
            with self.subTest(sentence):
                self.assertIsNone(SECRET.search(sentence))
                no_secrets({"text": sentence})

    def test_hostile_input_stays_fast_for_every_pattern_family(self):
        size = 200_000
        hostile = {
            "assignment": "token" + "-" * size,
            "repeated keyword": "password" * (size // 8),
            "colons": "a:" * (size // 2),
            "scheme": "http://" + "a:" * (size // 2),
            "long scheme": "a" * size + "://",
            "sk": "sk-" + "_" * size,
            "bearer": "Bearer " + " " * size,
            "github": "ghp_" + "a" * 19 + " " * size,
            "aws": "AKIA" + "A" * size,
            "jwt": "eyJ" + "a" * size,
            "jwt dots": "eyJaaaaaaaa." * (size // 12),
            "slack": "xoxb-" + "-" * size,
            "google": "AIza" + "a" * 29 + " " * size,
            "pem": "-----BEGIN " + "A" * size,
        }
        for name, text in hostile.items():
            with self.subTest(name):
                started = time.perf_counter()
                SECRET.search(text)
                self.assertLess(time.perf_counter() - started, 1.0, name)


if __name__ == "__main__":
    unittest.main()
