# Shared member skill discovery and workspace bindings

Status: steps 3–4 OS source implementation. Not yet admitted into a Core release.
Skills owns package import/revisions; OS owns discovery, selection and bindings.
Brain/host and Distribution provisioning are implemented locally in step 4; native callbacks remain unqualified; platform/composed
release qualification is step 5. No installed member files move automatically.

## One catalog, separate owners

The resolver combines OS built-ins, the configured immutable Skills generation,
legacy personal directories, Skills-owned member-library revisions, the explicitly
bound workspace and supported registered external packages. It never deep-scans
all workspaces, a home directory or arbitrary plugin caches. Query search precedes
output limits; use targeted queries/exact IDs rather than loading every procedure.

Member index contract: `aiverse-member-skill-library-v1`, at
`<personal-root>/.aiverse/member-library/index.json`. Consume exact owner paths,
portable package digests and active metadata. Verify visible package bytes and
metadata before returning candidates. Reject redirected/broken entries, unsupported
package structure, malformed/duplicate JSON and oversized metadata/packages.
Only shared revisions with explicit portability admission or the current
workspace's restricted revisions are candidates. Wrong-scope bodies are not read.
The source workspace is provenance; it grants no connection, context or data access.

Member identities use `local:skill-<UUID hex>`. Old local/workspace/OS/distributed
IDs remain valid, including admitted promotion compatibility receipts. A legacy
personal folder colliding with a member ID is an error, not an overwrite.
Same friendly names remain independent identities. Shared method is not a copy of
workspace settings; each workspace binds its own non-secret values.

## Installation binding

Optional local metadata: `.aiverse/capability-providers.json`:

```json
{"schema_version":1,"skills_root":"/absolute/managed-root","local_skills_root":"/absolute/personal-root","skills_entrypoint":"/absolute/owner/installer/aiverse_skills.py"}
```

Both provider roots are required; the optional Skills mutation entrypoint is an exact owner-established file. Explicit caller paths must agree; missing
configured providers remain absent/degraded rather than switching to another
installation. Managed/member roots must not overlap. With no file, existing
explicit arguments and legacy home defaults remain supported for compatibility.
Distribution calls the OS configuration owner preview/apply CLI during matching
Skills setup/reconcile. Python/Brain host construction and the optional adapter
installer now read this binding. Conflicting roots or entrypoints refuse. Native
callbacks and composed release behavior still require step 5 qualification.

## Selection

- Explicit qualified ID selects that exact available identity.
- Protected bare OS entrypoints remain OS; expose same-named alternatives.
- Other exact name collisions return `ambiguous` and alternatives.
- Saved workspace identity choice precedes operator identity choice. An unavailable
  saved target returns `unavailable`; no silent replacement.
- Equal top natural-language relevance returns ambiguity rather than a provider
  precedence winner. Ranking alone never grants permission to execute.
- Workspace inputs do not inherit operator inputs or another workspace's values.
  Operator identity preferences can apply across workspaces; their private inputs
  cannot. Invalid workspace identity/boundary cannot fall back to operator inputs.
- A pin can select a retained, verified member revision visible in current scope.
  Missing, damaged or restricted pins return unavailable. Other owners' historical
  versions must use their lifecycle, not an OS pointer rewrite.

## Scoped settings and preview/apply

OS contract `aiverse-skill-bindings-v1`:

```json
{"contract":"aiverse-skill-bindings-v1","preferences":{"scraper":"local:skill-example"},"skills":{"local:skill-example":{"inputs":{"channel":"example"}}}}
```

Stored at `operator/context/skill-bindings.json` or
`workspaces/<id>/context/skill-bindings.json`. Optional `revision` is a portable
content digest. Inputs are bounded JSON, not credentials. A Connection reference
is not authorization to use that Connection; execution must apply current scope
permissions, required inputs and readiness. Bindings themselves grant nothing.

Public APIs: `planCapabilityBinding(options)` and `applyCapabilityBinding(options)`
through `scripts/capability-resolver.mjs`. CLI JSON on stdin:

```json
{"operation":"plan-binding","scope":"workspace:alpha","qualified_id":"local:skill-example","alias":"scraper","binding":{"inputs":{"channel":"example"}}}
```

Then submit the exact result as `plan` with operation `apply-binding`, same root
and trusted scope. Both operations use the optional configured roots. Preview is
read-only, contract `aiverse-skill-binding-plan-v1`. It records physical OS root,
scope, exact identity, alias/binding, expected binding-file digest, provider-root
configuration, active generation/digest, selected digest and locator, and
`permission_granted:false`. Apply reselects and compares all evidence, refusing
skill/configuration/binding drift before save. Concurrent saves serialize with an
exclusive lock; interrupted unknown locks require review. Write via fsynced temp
file and atomic rename; local filesystem assumptions apply. Plan JSON is evidence,
not cryptographic authorization; host supplies trusted scope and permissions.

Protected aliases and prototype-polluting names cannot be saved as preferences.
Explicit selection of a different same-named package remains allowed. Save
bindings to a restricted workspace only when that workspace's physical boundary
and manifest ID are verified. Never ask the member for internal provider IDs as
an ordinary workflow; the host presents meaningful choices and submits identities.

## Supported external registrations (read-only)

Local metadata `.aiverse/capability-sources.json` uses a separate additive contract:

```json
{"contract":"aiverse-external-capability-sources-v1","sources":[{"id":"publisher","kind":"directory-packages-v1","root":"/absolute/publisher-root","supported":true,"installed":true,"enabled":true,"visibility":"shared","packages":[{"id":"tool","path":"tool","digest":"64-lowercase-hex-digest"}]}]}
```

Identity: `external:<source-id>:<package-id>`. This extends the OS catalog without
changing existing provider IDs or the managed Provider-v1 wire format. Stable
source/package IDs persist across publisher path changes; expected content digest
must be explicitly refreshed after publisher updates. Normal installation/update
of third-party packages remains with that publisher. No registration writer,
plugin installation or native runtime support is implied by this consumer.

At most 32 sources and 200 explicitly listed packages per source. Only
`directory-packages-v1` is supported. Read entries only when supported, installed
and enabled are all true, and visibility is shared or matches the trusted scope.
Never crawl unlisted packages. Validate relative paths, physical containment,
bounded package content and exact digest. Source roots/packages cannot expose
OS `operator`, `workspaces` or `connections` through an external registration.
Missing/changed sources yield diagnostics and zero selectable packages.
Unknown registrations are not mutated. Registration is not permission, execution
readiness, package safety admission or proof that a native desktop can load it.
Runtime paths that do not yet support this locator must refuse rather than guess.

## Evidence

- `node scripts/test-member-skill-library.mjs`
- `node scripts/test-capability-bindings.mjs`
- Existing resolver, placement and promotion acceptance scripts.
- `node scripts/test-member-library-owner.mjs --skills-source <step-2-checkout> --python <Python-3.11-or-newer>`

The last command exercises the real Skills owner CLI in disposable explicit roots,
then Node selection/bindings against its actual index, including retained revision
and private package refusals. It never invokes a personal launcher. This crossrepo
check is run locally against the recorded step 2 commit; CI wiring to admitted
crossrepo sources belongs to composed integration after those sources are published.

## Step 4 host and learning routes

The Python host accepts `skills.library-import` (scoped source folder, admission,
optional provenance and exact preview), `skills.binding-plan` and
`skills.binding-save`. Writes and learning enforce the OS permission floor and
valid scope. A sibling workspace source or unsafe path is refused. Prepared
ordinary skills and learned procedures use the same Skills-owned library API.

`capability.read_instructions` now supports verified directory/member and explicit
read-only external locators as well as managed generations. It rechecks bytes and
returns only current-scope inputs. For nonmanaged packages the receipt is
`aiverse-capability-read-v1`, not a forged managed Skills execution receipt. This
is instruction retrieval: no scripts, connections or tool effects are executed.

Configured new learning proposals use the member library after existing approval
or eligible auto policy. Brain forwards explicit `portability` declarations;
missing declarations do not imply portability. Workspace-only intent stays private.
Unknown portability stays restricted/draft and does not bypass private auto policy.
A configured member route does not modify the immutable managed generation.
Learning rollback disables its unchanged imported identity without deleting bytes.
Existing unconfigured owner flows remain backward compatible; historical managed
packages tagged `workspace_local` without a safe scoped location are withheld by
the OS catalog, with a diagnostic. Their originals/IDs are retained for explicit
owner review; no automatic migration or unproven scope repair occurs.

Fresh setup uses a private member-library sibling of the managed root. Existing
installations without a binding preserve their prior canonical personal root;
existing bindings cannot be silently rebound. Distribution preservation/recovery
uses the configured personal root and preserves external registrations. No actual
member installation is updated by these development changes.

Local composition command:
`python scripts/test-shared-skills-runtime.py --skills-source <checkout> --brain-source <checkout> --distribution-source <checkout>`.
Run in an isolated process with Python 3.11 or newer, never the operator launcher.
