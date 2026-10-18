# Optional OS extension packages

These packages are portable source owned by AI-Verse OS. Their presence in the OS repository does not install, enable, trust, or grant them data access.

Distribution may offer a package only from an exact admitted OS revision with a reviewed file allowlist and package digest. Adding or removing an optional package uses Distribution's explicit `aiverse upgrade --apply` lifecycle. Ordinary `aiverse update` does not change installed packages or Codex hook trust.

Packages install their own files and local registry entry under `.aiverse/extensions/`. They must generate paths for the target project, preserve unknown or locally changed files, and keep machine configuration, hook trust, receipts, Memory, Brain, Data, workspace data, and other user state out of the package.

Codex learning is currently an optional source package. No Codex version or platform support claim is made until Distribution lifecycle and actual callback behavior are qualified.
