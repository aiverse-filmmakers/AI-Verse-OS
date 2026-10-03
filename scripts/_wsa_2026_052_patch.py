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
    "import argparse\nimport hashlib\nimport importlib.util\nimport json\nfrom pathlib import Path\nimport re\nimport subprocess\nimport sys\nimport tempfile\n",
    "import argparse\nfrom contextlib import contextmanager\nimport errno\nimport hashlib\nimport importlib.util\nimport json\nimport os\nfrom pathlib import Path\nimport re\nimport subprocess\nimport sys\nimport tempfile\nimport time\n",
    "imports",
)

one(
    "_MIGRATION_MAX_PENDING_RESULTS = 64\n",
    "_MIGRATION_MAX_PENDING_RESULTS = 64\n_MIGRATION_SOURCE_LOCK_WAIT_SECONDS = 120.0\n_MIGRATION_SOURCE_LOCK_POLL_SECONDS = 0.05\n_MIGRATION_SOURCE_STATE_VERSION = \"1.0\"\n",
    "migration constants",
)

marker = '''    @staticmethod
    def _migration_bounded_list(plan: Mapping[str, Any], key: str, limit: int) -> list[Any]:
'''
helpers = r'''    def _migration_source_coordination_root(self, name: str) -> Path:
        if name not in {".source-locks", ".source-state"}:
            raise AdapterError("unsupported migration coordination root")
        receipts_root = self._migration_receipts_root()
        base = receipts_root / name
        if base.exists():
            if base.is_symlink() or not base.is_dir():
                raise AdapterError(f"migration coordination directory is unsafe: {name}")
        else:
            base.mkdir(mode=0o700)
        if not _inside(base.resolve(), receipts_root.resolve()):
            raise AdapterError("migration coordination directory escapes receipt ownership")
        return base

    @contextmanager
    def _migration_source_lock(self, source_digest: str):
        if not isinstance(source_digest, str) or not _HEX64.fullmatch(source_digest):
            raise AdapterError("migration source digest is invalid")
        locks_root = self._migration_source_coordination_root(".source-locks")
        lock_path = locks_root / f"{source_digest}.lock"
        if lock_path.exists() and (lock_path.is_symlink() or not lock_path.is_file()):
            raise AdapterError("migration source lock path is unsafe")
        handle = lock_path.open("a+b")
        acquired = False
        try:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
                os.fsync(handle.fileno())
            deadline = time.monotonic() + _MIGRATION_SOURCE_LOCK_WAIT_SECONDS
            while True:
                try:
                    handle.seek(0)
                    if os.name == "nt":
                        import msvcrt

                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                    break
                except OSError as exc:
                    if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK, None}:
                        raise AdapterError(f"migration source lock failed: {exc}") from exc
                    if time.monotonic() >= deadline:
                        raise AdapterError("migration source is busy; timed out waiting for the active import") from exc
                    time.sleep(_MIGRATION_SOURCE_LOCK_POLL_SECONDS)
            yield
        finally:
            try:
                if acquired:
                    handle.seek(0)
                    if os.name == "nt":
                        import msvcrt

                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()

    def _migration_import_identity(
        self,
        scope: str,
        parameters: Any,
    ) -> tuple[str, str, str, bool]:
        if scope != "operator":
            raise AdapterError("migration.import must begin at operator scope")
        if not isinstance(parameters, Mapping) or set(parameters) != {"source", "plan"}:
            raise AdapterError("migration.import parameters must contain exactly source and plan")
        source = parameters.get("source")
        plan = parameters.get("plan")
        if not isinstance(source, Mapping) or not isinstance(plan, Mapping):
            raise AdapterError("migration.import source and plan must be objects")
        source_allowed = {"kind", "text", "label"}
        if set(source) - source_allowed:
            raise AdapterError("migration.import source contains unsupported fields")
        source_kind = source.get("kind")
        source_text = source.get("text")
        source_label = source.get("label")
        if not isinstance(source_kind, str) or not source_kind.strip() or len(source_kind.strip()) > 80:
            raise AdapterError("migration.import source.kind is invalid")
        if not isinstance(source_text, str) or not source_text.strip() or "\x00" in source_text:
            raise AdapterError("migration.import source.text must be non-empty text")
        source_bytes = source_text.encode("utf-8")
        if len(source_bytes) > _MIGRATION_MAX_SOURCE_BYTES:
            raise AdapterError(
                f"migration.import source exceeds {_MIGRATION_MAX_SOURCE_BYTES} bytes; split it into bounded chunks"
            )
        if source_label is not None and (
            not isinstance(source_label, str) or not source_label.strip() or len(source_label.strip()) > 240
        ):
            raise AdapterError("migration.import source.label is invalid when provided")
        plan_allowed = {"profile", "workspaces", "memories", "data", "clarifications", "resolutions"}
        extras = set(plan) - plan_allowed
        if extras:
            raise AdapterError(
                "migration.import plan contains unsupported sections: " + ", ".join(sorted(extras))
            )
        profile = plan.get("profile")
        if profile is not None and not isinstance(profile, Mapping):
            raise AdapterError("migration.import profile must be an object when provided")
        self._migration_bounded_list(plan, "workspaces", _MIGRATION_MAX_WORKSPACES)
        self._migration_bounded_list(plan, "memories", _MIGRATION_MAX_MEMORIES)
        self._migration_bounded_list(plan, "data", _MIGRATION_MAX_DATA_ITEMS)
        self._migration_bounded_list(plan, "clarifications", _MIGRATION_MAX_CLARIFICATIONS)
        resolutions = self._migration_bounded_list(plan, "resolutions", _MIGRATION_MAX_RESOLUTIONS)
        try:
            plan_bytes = json.dumps(
                dict(plan),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise AdapterError(f"migration.import plan is not JSON-safe: {exc}") from exc
        if len(plan_bytes) > _MIGRATION_MAX_PLAN_BYTES:
            raise AdapterError(
                f"migration.import plan exceeds {_MIGRATION_MAX_PLAN_BYTES} bytes; split it into bounded chunks"
            )
        source_digest = hashlib.sha256(source_bytes).hexdigest()
        plan_digest = hashlib.sha256(plan_bytes).hexdigest()
        import_key = hashlib.sha256(f"{source_digest}:{plan_digest}".encode("utf-8")).hexdigest()
        return source_digest, plan_digest, import_key, bool(resolutions)

    def _migration_source_state_path(self, source_digest: str) -> Path:
        if not isinstance(source_digest, str) or not _HEX64.fullmatch(source_digest):
            raise AdapterError("migration source digest is invalid")
        return self._migration_source_coordination_root(".source-state") / f"{source_digest}.json"

    def _migration_load_source_state(self, source_digest: str) -> Optional[Dict[str, Any]]:
        path = self._migration_source_state_path(source_digest)
        if not path.exists():
            return None
        if path.is_symlink() or not path.is_file():
            raise AdapterError("migration source reservation is unsafe")
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise AdapterError(f"migration source reservation is invalid: {exc}") from exc
        if not isinstance(state, dict):
            raise AdapterError("migration source reservation must be an object")
        if (
            state.get("schema_version") != _MIGRATION_SOURCE_STATE_VERSION
            or state.get("owner") != "ai-verse-os"
            or state.get("operation") != "migration.import.source-reservation"
            or state.get("source_sha256") != source_digest
            or state.get("state") not in {"in-progress", "committed"}
            or not isinstance(state.get("plan_sha256"), str)
            or not _HEX64.fullmatch(state.get("plan_sha256"))
            or not isinstance(state.get("import_key"), str)
            or not _HEX64.fullmatch(state.get("import_key"))
            or not isinstance(state.get("started_at"), str)
            or not state.get("started_at")
            or not isinstance(state.get("recovery_count", 0), int)
            or isinstance(state.get("recovery_count", 0), bool)
            or state.get("recovery_count", 0) < 0
        ):
            raise AdapterError("migration source reservation owner/schema is invalid")
        if state.get("state") == "committed":
            expected_receipt = f"{state['import_key']}.json"
            if state.get("receipt") != expected_receipt:
                raise AdapterError("committed migration source reservation receipt binding is invalid")
        return state

    def _migration_source_receipts(self, source_digest: str) -> list[tuple[Path, Dict[str, Any]]]:
        receipts: list[tuple[Path, Dict[str, Any]]] = []
        for path in self._migration_receipts_root().glob("*.json"):
            if path.is_symlink() or not path.is_file():
                continue
            try:
                receipt = self._migration_load_receipt(path)
            except Exception:
                continue
            if receipt.get("source_sha256") == source_digest:
                receipts.append((path, receipt))
        receipts.sort(key=lambda item: item[0].name)
        return receipts

    def _migration_source_replay_response(
        self,
        request: Mapping[str, Any],
        scope: str,
        source_digest: str,
        incoming_plan_digest: str,
        prior: Mapping[str, Any],
    ) -> Dict[str, Any]:
        prior_plan_digest = prior.get("plan_sha256")
        exact = prior_plan_digest == incoming_plan_digest
        migration_import = {**dict(prior), "replayed": True, "replay_match": "source-and-plan" if exact else "source"}
        binding: Dict[str, Any] = {
            "request_fingerprint": _fingerprint(request),
            "scope": scope,
            "action_class": "write_local_reversible",
            "operation": "migration.import",
            "source_sha256": source_digest,
            "plan_sha256": incoming_plan_digest,
        }
        if not exact:
            migration_import["reclassified_plan_sha256"] = incoming_plan_digest
            binding["replayed_import_key"] = prior.get("import_key")
        return {
            "status": "succeeded",
            "effect_occurred": False,
            "result": {"migration_import": migration_import},
            "execution_binding": binding,
        }

    def _migration_admit_source(
        self,
        request: Mapping[str, Any],
        scope: str,
        source_digest: str,
        plan_digest: str,
        import_key: str,
    ) -> tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
        state_path = self._migration_source_state_path(source_digest)
        state = self._migration_load_source_state(source_digest)
        receipts = self._migration_source_receipts(source_digest)
        if len(receipts) > 1:
            raise AdapterError("multiple migration receipts already exist for this source; reconcile them before importing again")
        if receipts:
            receipt_path, prior = receipts[0]
            prior_import_key = prior.get("import_key")
            prior_plan_digest = prior.get("plan_sha256")
            if not isinstance(prior_import_key, str) or not _HEX64.fullmatch(prior_import_key):
                raise AdapterError("existing migration receipt import identity is invalid")
            if not isinstance(prior_plan_digest, str) or not _HEX64.fullmatch(prior_plan_digest):
                raise AdapterError("existing migration receipt plan identity is invalid")
            if state is not None and (
                state.get("import_key") != prior_import_key or state.get("plan_sha256") != prior_plan_digest
            ):
                raise AdapterError("migration source reservation conflicts with the committed source receipt")
            committed = {
                "schema_version": _MIGRATION_SOURCE_STATE_VERSION,
                "owner": "ai-verse-os",
                "operation": "migration.import.source-reservation",
                "state": "committed",
                "source_sha256": source_digest,
                "plan_sha256": prior_plan_digest,
                "import_key": prior_import_key,
                "started_at": (state or {}).get("started_at") or prior.get("completed_at") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "recovery_count": (state or {}).get("recovery_count", 0),
                "completed_at": prior.get("completed_at"),
                "receipt": receipt_path.name,
            }
            self._migration_atomic_json(state_path, committed)
            return committed, self._migration_source_replay_response(
                request, scope, source_digest, plan_digest, prior
            )
        if state is not None:
            if state.get("state") == "committed":
                raise AdapterError("migration source reservation is committed but its bound receipt is missing")
            if state.get("plan_sha256") != plan_digest or state.get("import_key") != import_key:
                raise AdapterError(
                    "migration source has an interrupted import bound to another classifier plan; "
                    f"recovery requires retrying plan {state.get('plan_sha256')} before reclassification"
                )
            resumed = dict(state)
            resumed["recovery_count"] = state.get("recovery_count", 0) + 1
            resumed["last_recovery_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            self._migration_atomic_json(state_path, resumed)
            return resumed, None
        started_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        fresh = {
            "schema_version": _MIGRATION_SOURCE_STATE_VERSION,
            "owner": "ai-verse-os",
            "operation": "migration.import.source-reservation",
            "state": "in-progress",
            "source_sha256": source_digest,
            "plan_sha256": plan_digest,
            "import_key": import_key,
            "started_at": started_at,
            "recovery_count": 0,
        }
        self._migration_atomic_json(state_path, fresh)
        return fresh, None

    def _migration_commit_source_state(
        self,
        state: Mapping[str, Any],
        receipt: Mapping[str, Any],
    ) -> None:
        source_digest = state.get("source_sha256")
        import_key = state.get("import_key")
        plan_digest = state.get("plan_sha256")
        if (
            receipt.get("source_sha256") != source_digest
            or receipt.get("import_key") != import_key
            or receipt.get("plan_sha256") != plan_digest
        ):
            raise AdapterError("migration result does not match its source reservation")
        committed = dict(state)
        committed.update(
            {
                "state": "committed",
                "completed_at": receipt.get("completed_at"),
                "receipt": f"{import_key}.json",
            }
        )
        self._migration_atomic_json(self._migration_source_state_path(source_digest), committed)

'''
one(marker, helpers + marker, "migration helpers")

old_method = '''    def _request_migration_import(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
'''
new_method = '''    def _request_migration_import(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        source_digest, plan_digest, import_key, has_resolutions = self._migration_import_identity(
            scope, parameters
        )
        if has_resolutions:
            return self._request_migration_import_once(request, scope, parameters)
        with self._migration_source_lock(source_digest):
            source_state, replay = self._migration_admit_source(
                request,
                scope,
                source_digest,
                plan_digest,
                import_key,
            )
            if replay is not None:
                return replay
            result = self._request_migration_import_once(
                request,
                scope,
                parameters,
                source_reserved=True,
                source_started_at=source_state["started_at"],
            )
            migration_import = result.get("result", {}).get("migration_import")
            if not isinstance(migration_import, Mapping):
                raise AdapterError("migration import completed without a canonical receipt payload")
            self._migration_commit_source_state(source_state, migration_import)
            return result

    def _request_migration_import_once(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
        *,
        source_reserved: bool = False,
        source_started_at: Optional[str] = None,
    ) -> Dict[str, Any]:
'''
one(old_method, new_method, "migration wrapper")

one(
    "        if not resolution_items:\n            prior_source_receipts: list[tuple[float, Path, Dict[str, Any]]] = []\n",
    "        if not resolution_items and not source_reserved:\n            prior_source_receipts: list[tuple[float, Path, Dict[str, Any]]] = []\n",
    "source replay guard",
)

one(
    '                "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),\n',
    '                "created_at": source_started_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),\n',
    "deterministic migration data timestamp",
)

path.write_text(text, encoding="utf-8")
