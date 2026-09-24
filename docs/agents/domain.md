# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `docs/00-overview.md` — project overview, key mechanisms, conventions (start here)
- `docs/modules/*.md` — frozen contracts per module; `sessions-relay.md` is the authoritative
  relay contract (waiting records, permission buttons, question wizard, supersede history)
- `docs/todos/*.md` — historical round plans with status lines (context only, not authority)
- `docs/adr/` — ADRs, if present. None exist yet; they are created lazily by the domain-modeling
  skill when architectural decisions actually get resolved. Absence is not a gap to flag.

## Use the project's vocabulary

When naming a domain concept (issue titles, hypotheses, test names), use the terms as used in
`docs/00-overview.md` and `docs/modules/*.md` — e.g. session projection, waiting record,
waiting-notify debounce, poller lock, registry, self-update staging. Do not drift to synonyms
those docs avoid.

## Flag contract conflicts

If output contradicts a frozen contract in `docs/modules/*.md`, surface it explicitly (with a
supersede note) rather than silently overriding.
