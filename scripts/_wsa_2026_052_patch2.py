from pathlib import Path

path = Path("scripts/ai_verse_host_adapter.py")
text = path.read_text(encoding="utf-8")


def one(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    text = text.replace(old, new, 1)


one(
'''        inbox = operator / "inbox"
        if inbox.exists():
            if inbox.is_symlink() or not inbox.is_dir():
                raise AdapterError("operator inbox is unsafe")
        else:
            inbox.mkdir(mode=0o700)
        base = inbox / "migration-imports"
        if base.exists():
            if base.is_symlink() or not base.is_dir():
                raise AdapterError("migration import receipt directory is unsafe")
        else:
            base.mkdir(mode=0o700)
''',
'''        inbox = operator / "inbox"
        if not inbox.exists():
            try:
                inbox.mkdir(mode=0o700)
            except FileExistsError:
                pass
        if inbox.is_symlink() or not inbox.is_dir():
            raise AdapterError("operator inbox is unsafe")
        base = inbox / "migration-imports"
        if not base.exists():
            try:
                base.mkdir(mode=0o700)
            except FileExistsError:
                pass
        if base.is_symlink() or not base.is_dir():
            raise AdapterError("migration import receipt directory is unsafe")
''',
"receipt directory creation",
)

one(
'''        base = receipts_root / name
        if base.exists():
            if base.is_symlink() or not base.is_dir():
                raise AdapterError(f"migration coordination directory is unsafe: {name}")
        else:
            base.mkdir(mode=0o700)
''',
'''        base = receipts_root / name
        if not base.exists():
            try:
                base.mkdir(mode=0o700)
            except FileExistsError:
                pass
        if base.is_symlink() or not base.is_dir():
            raise AdapterError(f"migration coordination directory is unsafe: {name}")
''',
"coordination directory creation",
)

path.write_text(text, encoding="utf-8")
