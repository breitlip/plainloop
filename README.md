# plainloop — endless-loop mission driver for pi

Endless-loop driver: runs a mission as a chain of small pi sessions,
steered over pi's RPC protocol. The design lives in the
the [plainloop skill](skills/plainloop/SKILL.md); this directory is
the machinery.

## How it works

```
plainloop/plainloop.mjs (no LLM context)
  ├─ parent    one `pi --mode rpc` session per task (plainloop-parent-NNNN-<mission>)
  │             writes TASK.md, diagnoses failures — fresh each task (stateless,
  │             nothing accumulates, nothing to compact)
  └─ worker    one `pi --mode rpc` session per task (plainloop-task-NNNN-<mission>)
                executes TASK.md; steered on timeout, aborted if it never settles
```

All sessions are normal pi sessions — visible in pi-web and in
`~/.pi/agent/sessions/`.

## Inbox, scheduled execution, event log

### Flow

```mermaid
flowchart TD
    START([driver run]) --> EXIT{exit command<br/>succeeds?}
    EXIT -- yes --> DONE([stop: mission done])
    EXIT -- no --> INBOX{INBOX.md has<br/>new entries?}
    INBOX -- yes --> DRAIN["drain entries into context<br/>(timestamped, logged to events.jsonl)"]
    INBOX -- no --> SCHED
    DRAIN --> SCHED{execution time<br/>reached?}
    SCHED -- "no: future Execute at/when header" --> WAIT["poll condition /<br/>sleep until time (logged)"]
    WAIT --> SCHED
    WAIT -- "new INBOX.md entry<br/>(interrupts the wait)" --> DRAIN
    SCHED -- "yes (absent = immediate)" --> PARENT["parent writes TASK.md"]
    PARENT --> PREPLY{parent reply}
    PREPLY -- "STOP <reason>" --> STOPPED([stop: parent reason])
    PREPLY -- READY --> WORKER["worker executes TASK.md"]
    WORKER --> HOT{inbox changed while<br/>worker runs?}
    HOT -- "yes + steerOnInbox" --> STEER["steer running worker<br/>with new entry"]
    STEER --> WORKER
    HOT -- "no / cold path" --> VERIFY{verify command<br/>passes?}
    VERIFY -- no --> RETRYQ{retries left?}
    VERIFY -- yes --> ARCHIVE["archive to history/TASK-NNNN.md<br/>stamp events.jsonl"]
    RETRYQ -- yes --> CORRECT["parent writes corrective TASK.md"]
    CORRECT --> PARENT
    RETRYQ -- no --> FAIL([stop: retries exhausted])
    ARCHIVE --> EXIT
```

### Execution-time headers

`TASK.md` and `INBOX.md` entries accept an optional execution-time header.
**Absent = immediate** — the default when no header is present.

```text
Execute at: 2026-03-01T09:00:00+01:00                    # fixed time (ISO-8601)
Execute when: test -f done.flag && grep -q ok ci.log      # polled shell condition
```

The driver parks the loop (logged to `events.jsonl`) until the time is
reached or the condition succeeds, then continues. Precedence when several
sources declare a time: **inbox entry header → TASK.md header → `driver.json`
`wait` → immediate**.

**The inbox is the interrupt door:** a new `INBOX.md` entry appended while
the driver waits ends the wait immediately (checked every second, logged as
`wait_interrupted`). The fresh entry is drained and routed to the parent on
the next round — the inbox always wins over the schedule.

### INBOX.md entry format

Writers append at any time — no timing required. Each entry is a block:

```markdown
## [2026-02-01T14:03:00+01:00] add tax rule
Execute at: 2026-03-01T09:00:00+01:00   # optional, absent = immediate
priority: steer                         # optional: steer | stop (hot path)

Body: what to add and where it belongs…
```

- **Cold path (default):** the driver drains new entries at the iteration
  boundary (after archive, before the next parent prompt) and folds them into
  the next TASK.md context.
- **Hot path (opt-in, `steerOnInbox: true`):** while the worker runs, a new
  entry triggers an RPC `steer` of the live worker session; `priority: stop`
  aborts instead.
- **Wait interrupt (default):** a new entry while the driver is parked in a
  wait ends the wait immediately; the entry is drained and routed to the
  parent on the next round.
- The driver records the last-drained timestamp so restarts never double-drain.

### Event log

`events.jsonl` in the mission dir: one `{ts, event, detail}` line per driver
action — task start/end, parent/worker spawn/settle/timeout/retry, verify,
inbox drain, wait begin/end/interrupt. Append-only, machine-readable; gives
crash recovery, timing analysis, and an audit trail. `status` renders the
last N events.

## Install

The package is a standard pi package (extension + skill), so install it from
the repo with `pi install`:

```bash
# from GitHub
pi install git:github.com/breitlip/plainloop
pi install https://github.com/breitlip/plainloop   # raw URLs work too

# pin a ref
pi install git:github.com/breitlip/plainloop@v0.2.0

# or from a local checkout
pi install /path/to/plainloop
```

By default this writes to your user settings (`~/.pi/agent/settings.json`).
Use `-l` to install into project settings (`.pi/settings.json`) instead, or
`pi -e git:github.com/breitlip/plainloop` to try it for one run without
installing.

Verify with `pi list`, then restart pi (or start a new session) so the
`/plainloop` commands and the `plainloop` tool become available.

## Using from inside pi

The package ships a pi extension, so in any pi session (TUI, RPC, pi-web):

```text
/plainloop status [mission]                 # progress, liveness, log tail, work summary
/plainloop run <mission> [--max N] [--dry-run]
/plainloop stop [mission]
/plainloop list [mission]                   # the mission's pi sessions (open them in pi-web)
/plainloop version                          # installed extension version + install path
/plainloop help
```

`mission` can be a name (`missions/foo`), a path, or a number from
`/plainloop list` (1..n, in list order) — e.g. `status 2` instead of
`status missions/another-id`. The longer forms keep working.

`status` answers "is it actually running?" — driver pid liveness, the
current phase (`run — worker (task 3)` or `wait until … (remaining hh:mm:ss)`),
the last `driver.log` lines, the last `events.jsonl` events, plus a work
summary (latest completed task, CURRENT.md, STATE.md).

`list` shows every plainloop session for the mission (parent, task-NNNN, and
legacy review-NNNN) with last activity and size — they live in pi-web under
the session cwd (the repo root by default).

`version` is handy for checking what is actually loaded, since pi-web's
Settings → Pi packages panel only shows the source and install path, not
the version.

`run` starts the driver as a detached background process — the session stays
responsive and you get a notification when the run finishes. The driver also
writes `<mission>/.plainloop.pid`, so `stop` works even if the starting
session is gone.

There is also a `plainloop` tool, so you can simply ask the agent:
*"run the count mission for 20 iterations and tell me the result".*

## Usage (shell)

A ready-to-run example mission ships in `missions/count-to-1000` (see its
README) — the smallest mission that exercises the full loop:

```bash
node plainloop.mjs run missions/count-to-1000 --max 5 --verbose
node plainloop.mjs status missions/count-to-1000
node plainloop.mjs run missions/<name> --dry-run   # show prompts, no pi
node plainloop.mjs supervise                        # keep missions running (see below)
```

Flags:

- `--max N` — stop this run after N iterations (the mission itself keeps
  its own exit criteria)
- `--dry-run` — print the rendered prompts and checks, spawn nothing
- `--verbose` — echo the driver log to stdout

## Mission directory contract

```
<mission>/
├── MISSION.md    invariant: goal, constraints, exit criteria, protocol
├── STATE.md      durable state (sessions update per TASK.md)
├── TASK.md       current task brief (parent writes, worker executes)
├── CURRENT.md    worker scratch
├── INBOX.md      optional drop-in entries, drained by the driver each iteration
├── history/      completed briefs: TASK-0001.md, TASK-0002.md, ...
├── driver.json   driver contract (all keys optional)
├── events.jsonl  append-only timestamped driver event log
├── .plainloop.state.json  current phase (run/wait), cleared when the run ends
├── driver.log    append-only driver activity log
└── driver.err.log driver stderr (crash diagnostics) when started via the extension
```

### driver.json (optional)

A mission is markdown-first: `MISSION.md` states the goal, constraints and
**exit criteria**, and the parent judges each outcome and replies `STOP`
when the exit criteria are met. That works with **no `driver.json` at all** —
every key below is optional and has a sensible default. Add `driver.json`
only when you want the driver to enforce things *deterministically* (a shell
`verify`/`exit` gate instead of the parent's judgment), schedule work, or
tune timeouts and retries.

| Key | Default | Meaning |
|---|---|---|
| `taskPrompt` | see driver | Prompt for the parent to write `TASK.md`. Parent replies `READY` or `STOP <reason>`. Template vars: `{{dir}} {{n}} {{count}} {{next}}` |
| `workerPrompt` | see driver | Prompt for the worker session. Same template vars |
| `verify` | `null` | Shell command (run in mission dir) that must succeed after each task. Template vars allowed. `null` = no deterministic gate (the parent judges the outcome when writing the next task) |
| `exit` | `null` | Shell command (run in mission dir); success = mission done, loop stops. `null` = the parent decides (it replies `STOP` when the MISSION.md exit criteria are met) |
| `wait` | `null` | Execution gate per iteration: `{"at":"2026-03-01T09:00:00+01:00"}` or `{"command":"test -f done.flag","intervalMs":30000,"timeoutMs":0}` (`timeoutMs` 0 = wait forever). Lower precedence than `Execute at/when` headers in INBOX.md entries or TASK.md |
| `countPattern` | `null` | Regex with one capture group, matched in STATE.md to derive `{{count}}` |
| `sessionCwd` | git root | cwd for the spawned pi sessions (pi keys sessions by cwd — defaulting to the repo root keeps them visible under the project in pi-web). Mission dir if no git root |
| `parentTimeoutSec` | `180` | Parent run timeout (writing `TASK.md`) before the driver gives up |
| `workerTimeoutSec` | `240` | Worker run timeout before the driver steers it |
| `steerGraceSec` | `60` | Grace period after steering before aborting |
| `maxRetries` | `1` | Worker retries per task (each retry gets a parent-written corrective TASK.md) |
| `parentRetries` | `1` | Retries when the parent settles without writing `TASK.md` and without replying `STOP` (e.g. a thinking-only turn). The driver re-prompts the **same** parent session with a corrective nudge; an explicit `STOP` reply is never retried. `0` = hard-stop on the first such settle |
| `transientRetryMaxSec` | `14400` | Per-run time budget for **transient** failures (LLM unreachable, session died, timeouts): the driver backs off and retries the same task instead of stopping. `0` = hard-stop (legacy behavior) |
| `transientBackoffSec` | `60` | Initial backoff delay between transient retries (doubles each consecutive failure) |
| `transientBackoffCapSec` | `900` | Cap for the transient backoff delay |
| `steerOnInbox` | `false` | Hot path: new INBOX.md entries while the worker runs steer the live worker session (`priority: stop` in an entry aborts it) |
| `inboxPollMs` | `5000` | Inbox poll interval while the worker runs (only used with `steerOnInbox`) |

Unknown keys in `driver.json` never break a run — they are ignored, with a
warning on stderr. Keys removed in a release (e.g. `review` since v0.5.0) warn
that they are no longer supported. Keys starting with `_` are treated as
comments and silently ignored.

## Failure handling

Failures split into two classes, handled differently:

**Semantic** (the work settled but was judged wrong): the verify command
failed. Per task the driver runs **worker → verify → archive**, and each
semantic failure consumes one retry:

1. Worker times out → driver sends a `steer` ("stop, finish the minimal
   STATE.md update") → grace period → `abort`.
2. Verify fails → the parent inspects CURRENT.md/STATE.md (plus the failure
   reason) and writes a corrected, smaller TASK.md.
3. Retries exhausted (`maxRetries`) → driver stops with a clear line in
   `driver.log` and a non-zero exit code. Resume by fixing the files and
   running again — the loop is stateless; `history/` + STATE.md is the truth.

**Transient** (the session could not reach the model): LLM unreachable,
timeout, pi process died, steering failed. The driver does NOT stop right
away — it backs off exponentially (`transientBackoffSec` → `transientBackoffCapSec`)
and retries the **same task** with a fresh worker, bounded by the per-run
`transientRetryMaxSec` budget (default 4h). A dead parent session is
respawned (the loop is file-based, so a fresh parent reads MISSION/STATE/
history). A new INBOX.md entry interrupts any backoff wait and is routed
through the parent as usual. Events: `transient_retry`,
`transient_budget_exhausted`, `backoff_interrupted`.

When the budget is exhausted the run exits non-zero — which is exactly what
`supervise` (below) turns into a backoff + relaunch. While a backoff wait is
in flight, `plainloop status` shows the live state instead of a stale phase:

```
current:      waiting on LLM — retry in 00:04:31 (budget 180/14400s) — last: worker did not settle
```

The parent judges each outcome: it reads the archived brief, STATE.md and
CURRENT.md before writing the next TASK.md, and writes a corrective TASK.md
when the work was not done (verify failure, or its own judgment).

## Supervise (crash / reboot resilience)

`plainloop supervise [--config PATH]` is a plain-Node supervisor (no LLM
needed) that keeps a configured set of missions running:

```json
// ~/.config/plainloop/supervise.json
{
  "missions": ["/abs/path/to/mission"],
  "pollSec": 30,
  "backoffSec": 60,
  "maxBackoffSec": 900
}
```

Per mission, every poll:

- **exit criteria met** (the mission's `driver.json` `exit` command succeeds)
  → marked done, never relaunched;
- **already running** (live pidfile) → left alone;
- **failed previously** → relaunched after exponential backoff
  (`backoffSec` → `maxBackoffSec`);
- otherwise → launched as `plainloop run <mission> --verbose`, logging to
  the mission's `driver.out.log` / `driver.err.log` as before.

Exit 0 (mission completed — exit criteria met, or the parent replied `STOP`
with a done verdict) marks it done; exit 1 (failure) schedules a relaunch. The supervisor is single-instance (pidfile next to the config,
stale pidfiles from crashes/reboots are cleared), and `run` itself refuses
to start a second instance for the same mission.

### systemd (user service, survives reboots)

```ini
# ~/.config/systemd/user/plainloop-supervise.service
[Unit]
Description=Plainloop mission supervisor
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/plainloop/plainloop.mjs supervise
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now plainloop-supervise
loginctl enable-linger $USER   # start at boot without a login session
```

## Notes

- The driver splits stdout on `\n` only (LF framing per the RPC protocol);
  it never uses generic line readers.
- `PI_BIN` env var overrides the `pi` binary (default: `pi` on PATH).
- Parent/worker session names are `plainloop-parent-NNNN-<mission>` /
  `plainloop-task-NNNN-<mission>` so they are easy to find in pi-web (legacy
  `plainloop-review-NNNN-<mission>` sessions from older versions are still
  listed by `list`).
