# AGENTS.md

## Agent skills

### Issue tracker

Issues live in GitHub Issues for NotchL1118/Sofiar (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Running Sofia

`~/.sofia/` is the Owner's **production** data: its `timeline.db` is the companion's permanent memory, and everything said to it stays in her context forever.

Run every manual test, smoke run, or experiment against the dev data directory:

```
SOFIA_HOME=~/.sofia-dev pnpm sofia start --terminal
```

`~/.sofia-dev/` has its own `config.json`, `secrets.json`, persona and Timeline; copy the first two from `~/.sofia/` if it is missing. Automated tests use temp directories. Touch `~/.sofia/` (run against it, edit or delete files in it) only when the Owner asks for that explicitly. See `docs/architecture.md` §2.3.

## Where to start

- `docs/architecture.md` is the design every package implements; when code and doc disagree, fix one of them in the same change.
- Writing or changing an Extension: read `docs/extending.md` first.
- Desktop client or its WebSocket protocol: `apps/desktop/README.md`.
- Admin page or its HTTP API: `apps/admin-web/README.md`.
- `pnpm test` and `pnpm typecheck` must both pass before a change is done.
