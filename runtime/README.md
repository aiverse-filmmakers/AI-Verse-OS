# Runtime

`runtime/` contains derived state that can be regenerated.

Typical contents:

```text
runtime/
├── cache/
├── indexes/
├── logs/
├── reports/
├── temp/
└── generated/
```

The directory contents are gitignored by default.

Vector databases, embeddings, generated catalogs, search indexes, health reports, caches, and temporary execution files belong here when they are reproducible from canonical sources.

**Invariant:** if deleting `runtime/` destroys irreplaceable operator or workspace knowledge, that data was stored in the wrong layer.
