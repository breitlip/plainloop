# count-to-1000 — a minimal example mission

The smallest mission that exercises the whole loop: a parent pi session
writes one tiny task (increment a counter), a worker pi session executes it,
the parent judges the outcome, and the driver archives the brief to
`history/`. Repeat until the counter hits 1000 (or you stop it).

This mission is **pure markdown** — no driver.json. The parent judges each
outcome from STATE.md and replies `STOP` once the counter reads 1000 (the
exit criteria live in MISSION.md); the driver only enforces timeouts,
retries, and the archive.

## Try it

```bash
# from the plainloop repo root
node plainloop.mjs run missions/count-to-1000 --max 5 --verbose
```

`--max 5` stops after 5 iterations so the demo stays cheap. Watch:

- `TASK.md` rewritten each iteration, then archived to `history/TASK-000N.md`
- `STATE.md` counter climbing 0 → 1 → 2 …
- `events.jsonl` — every driver action, timestamped
- the pi sessions `plainloop-parent-count-to-1000` and
  `plainloop-task-NNNN-count-to-1000` (visible in pi-web)

Other things to try:

```bash
node plainloop.mjs status missions/count-to-1000     # progress + event tail
node plainloop.mjs run missions/count-to-1000 --dry-run   # print prompts, spawn nothing
```

From inside pi, just ask: *"run the count-to-1000 mission for 5 iterations
and tell me the result"* — or use `/plainloop run count-to-1000 --max 5`.

## Files

| File | Who owns it | Role |
|---|---|---|
| `MISSION.md` | parent | goal, constraints, exit criteria, loop protocol (workers read-only) |
| `STATE.md` | workers | durable state — here, just the counter |
| `TASK.md` | parent → worker | the current one-objective brief |
| `CURRENT.md` | worker | scratch notes, crash recovery |
| `history/` | driver | archived briefs — one file per completed iteration |
| `events.jsonl` | driver | append-only event log |

(No `driver.json` — see the main README for the optional deterministic
`verify`/`exit` gates and other tuning knobs.)

## To make your own mission

Copy this directory, change the goal in `MISSION.md`, seed `STATE.md`, and
write deterministic `verify`/`exit` commands in `driver.json` if you can.
See the [plainloop skill](../../skills/plainloop/SKILL.md) for the full
contract.
