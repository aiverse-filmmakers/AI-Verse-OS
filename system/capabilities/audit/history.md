# Audit History Rules

Audit reports are point-in-time evidence. Preserve earlier reports and compare findings using stable IDs when possible.

## Finding lifecycle

A finding can be:

- `new`
- `still-open`
- `resolved`
- `reopened`
- `not-rechecked`
- `no-longer-applicable`

## Resolution rule

Do not mark a finding resolved merely because a file changed. Resolution requires fresh evidence that the underlying issue is no longer present.

## Comparing scores

A score can change because:

- a real defect was fixed
- a connection or workflow became verifiable
- coverage expanded
- the audit used stronger evidence
- the scope changed

Explain which reason applies. Do not present every score increase as operational improvement.

## Privacy

Audit reports may contain private project names, paths, connection details, or business context. They are gitignored by default.
