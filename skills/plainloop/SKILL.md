---
name: plainloop
description: "Run long-running goals as a chain of small, self-contained sessions coordinated through shared markdown files (MISSION.md, STATE.md, TASK.md, CURRENT.md) and steered over pi's RPC protocol. A stateless driver script writes per-iteration tasks, spawns worker sessions, verifies results, runs an independent read-only reviewer, and archives. USE FOR: endless loops, iterative missions, relay chains, autonomous multi-session work, decomposing a big goal into per-session tasks, parent-child session handoff via files, long-running experiments, plainloop. DO NOT USE FOR: single-shot tasks that fit in one session, tasks with no persistence requirement."
---

# Plainloop

A pattern for pursuing a goal that is too big for one session: break it into
many small iterations. Each iteration is a fresh session that reads shared
files, does exactly one small task, updates shared state, and exits. A parent
agent (you, the orchestrator) drives the loop: it writes each task, spawns the
session, verifies the result, and decides whether to continue.

Sessions share state **only through files**. They have no other memory of each
other. The files are the contract.

## File layout

Every mission lives in its own directory:

```
<mission-dir>/
├── MISSION.md      # invariant — goal, constraints, exit criteria, protocol
├── STATE.md        # durable knowledge only — no per-iteration log
├── TASK.md         # the current task brief, written by the parent
├── CURRENT.md      # session scratch: what this session is doing, partial results
├── INBOX.md        # optional drop-in entries, drained by the driver each iteration
├── events.jsonl    # append-only timestamped driver event log
└── history/        # completed task briefs: TASK-001.md, TASK-002.md, ...
```

`history/` is the iteration record. The number of files in it is the number
of completed iterations; the next task number is that count + 1. The record
lives in files, never in STATE.md.

### MISSION.md (parent-owned, sessions read-only)

- **Goal** — one paragraph, what "done" means.
- **Constraints** — what sessions must not touch, scope, style rules.
- **Exit criteria** — explicit, checkable conditions for stopping the loop.
- **Loop protocol** — the contract every session must follow (copy from below).

The parent may edit MISSION.md to change direction; sessions never may.

### STATE.md (the brain — durable knowledge only)

Structured sections so it does not degrade into a wall of text:

- **Digest** — 10–20 lines, the compressed memory. Rewritten by the parent
  when knowledge grows. Holds the mission's live state (e.g. a counter).
- **Learnings** — durable facts ("X fails because Y", "Z works, use it").
- **Decisions** — what was chosen and why (prevents re-litigating).
- **Open questions** — things the next session should investigate.

**No per-iteration log here.** The completed-task history in `history/` is
the record of what happened; STATE.md holds only what still matters.

### TASK.md (parent writes, session executes)

- **Objective** — exactly one small thing, finishable in a single session.
- **Context** — which STATE.md sections matter.
- **State updates** — what to write into STATE.md when done.
- **Do-not** — reminders if past sessions drifted.

After the parent verifies a task, it moves TASK.md to
`history/TASK-NNN.md` (NNN = zero-padded task number) before writing the
next one. The history file is the permanent record of that iteration.

### CURRENT.md (session-owned, disposable)

- What this session is doing right now, partial results, dead ends so far.
- Main value: **crash recovery** — if a session dies mid-work, the next one
  reads this instead of starting blind.
- Session overwrites it at start, updates it as it goes.

## Loop protocol

The contract each session must follow. Copy into MISSION.md:

```
1. Read MISSION.md, STATE.md, TASK.md (and CURRENT.md if it exists).
2. Do ONLY the objective in TASK.md. One thing. Small.
3. Update CURRENT.md as you go (scratch notes, partial results).
4. Before finishing: update STATE.md with the state changes required by
   TASK.md and any durable learnings. Never rewrite unrelated Digest content.
5. Do NOT edit MISSION.md. Do NOT start tangential work.
6. Finish. The parent takes over.
```

## Parent loop

For each iteration:

1. Read MISSION.md + STATE.md (and CURRENT.md if a previous session crashed).
   Determine the next task number: files in `history/` + 1.
2. Write TASK.md: one small objective, context pointers, required state updates.
3. Spawn the session. In pi, use the `subagent` tool with a task like:
   `Mission dir: <path>. Read MISSION.md, STATE.md, TASK.md and follow the
   loop protocol in MISSION.md exactly. Do only the TASK.md objective.`
4. Verify: did STATE.md change as TASK.md required? If not, treat the session
   as failed — write a corrective TASK.md and retry.
5. Archive the completed brief: move TASK.md to `history/TASK-NNN.md`.
6. Check exit criteria in MISSION.md. If met → stop. Otherwise → go to 1.

## Rules that prevent failure modes

- **The parent is stateless.** The parent session may be compacted or
  restarted at any time. Everything needed to resume the loop must be
  derivable from the files: the mission state from STATE.md, the iteration
  count from `history/`, the in-flight work from TASK.md + CURRENT.md.
  If you cannot resume from the files alone, write it to a file.
- **One objective per iteration.** Small enough to finish in one session.
- **Sessions never edit MISSION.md.** Only the parent changes direction.
- **No per-iteration log in STATE.md.** Completed tasks are archived in
  `history/`; STATE.md keeps only durable knowledge.
- **Hard stops:** exit criteria met, iteration cap reached, or budget exhausted.
- **Verify before continuing.** A session that didn't update STATE.md as
  required produced no state change; the loop must not pretend it did.

## Choosing the driver

- **Interactive (good for starting):** parent runs the loop in chat,
  spawning one session per iteration. The user can interject anytime.
  Parent context grows linearly; compact between iterations if needed.
- **Scripted:** a `workflowScript` loops N iterations with the parent reviewing
  STATE.md between rounds. More autonomous.
- **Headless one-shot:** a shell script spawns fresh `pi -p` sessions per
  iteration. No steering possible; abort = kill the process.
- **pi-web relay:** the pi-web `relays` package provides a native
  `spawn_session` tool and a `relay` skill. Each leg is a real pi-web session
  and there is no persistent parent: each session does one leg, writes
  durable state, and spawns the next (fire-and-forget). See the `relay` skill
  for the charter/status/log packet and handoff format.
- **RPC driver (recommended for unattended runs):** a small script speaks
  pi's RPC protocol (`pi --mode rpc`, JSONL over stdin/stdout) and gets a
  full steering surface over real, visible pi sessions. See
  [RPC driver](#rpc-driver).

## RPC driver

A driver script (no LLM context) supervises the loop and steers two kinds of
pi sessions over RPC:

- **parent** — one long-lived `pi --mode rpc` session. Writes each TASK.md,
  diagnoses failures, and is **compacted on demand** by the driver
  (`{"type": "compact", "customInstructions": "..."}`) every N iterations.
- **worker** — one `pi --mode rpc` session per task. Executes TASK.md. On
  timeout the driver sends `steer` ("stop, finish the minimal state update"),
  waits a grace period, then `abort`s and retries with a parent-written
  corrective TASK.md.

Useful RPC commands (JSONL, one per line on stdin):

| Command | Effect |
|---|---|
| `{"type":"prompt","message":"..."}` | run work; response arrives when settled |
| `{"type":"steer","message":"..."}` | redirect a running session mid-flight |
| `{"type":"follow_up","message":"..."}` | queue work after the current run |
| `{"type":"abort"}` | kill the current run |
| `{"type":"compact","customInstructions":"..."}` | compact on demand |
| `{"type":"get_state"}` / `{"type":"get_messages"}` | inspect the session |
| `{"type":"new_session","parentSession":"<path>"}` | fork a clean session |

Protocol notes: responses echo the `id` you send; events stream as JSONL
(`agent_start`, `agent_end` with `messages`, `tool_execution_*`, ...);
frame strictly on `\n` (Node `readline` is not compliant). The last assistant
text of a run is readable from `agent_end.messages` — use it for
`READY`/`STOP` style decisions.

The driver keeps the mission contract (MISSION/STATE/TASK/CURRENT/history)
and adds a `driver.json` with the machine-checkable parts: `verify` and
`exit` shell commands, `countPattern`, `compactEvery`, worker timeouts,
retry policy (worker `maxRetries`, parent `parentRetries`). The reference
implementation ships with this package as
`driver.mjs` (see the package README).

Running the driver: it is a plain Node script, no dependencies. `driver.mjs`
lives at the package root, next to `skills/`. Typical install locations:

```text
git install:  ~/.pi/agent/git/github.com/<user>/plainloop/driver.mjs
npm install:  ~/.pi/agent/npm/node_modules/plainloop/driver.mjs
```

```bash
node ~/.pi/agent/git/github.com/<user>/plainloop/driver.mjs run <mission-dir> --max 5 --verbose
node <driver> status <mission-dir>
```

If a `plainloop` bin is on PATH (some installs link it), `plainloop run …`
works directly. When in doubt: `find ~/.pi/agent -name driver.mjs -path "*plainloop*"`.


Reference implementation flow per task:

1. parent: write TASK.md (replies `READY` or `STOP <reason>`; if it settles
   with neither, the driver re-prompts the same parent up to `parentRetries`
   times — a `STOP` reply is final and never retried)
2. worker: execute TASK.md (steer → abort → retry on timeout)
3. driver: run `verify` command; on failure → corrective retry
4. reviewer: independent read-only session replies `APPROVE` or
   `REJECT <reason>`; on reject → corrective retry
5. driver: archive TASK.md → `history/TASK-NNNN.md`
6. every N tasks: driver compacts the parent
7. `exit` command succeeds, or parent says STOP → done

## Inbox, scheduled execution, event log

- **INBOX.md** — drop-in entries you can append at *any* time (no timing
  between iterations needed). Entry format: a `## [ISO-8601] summary` block.
  The driver drains new entries at the start of each iteration and hands them
  to the parent for routing: durable knowledge → STATE.md, direction →
  MISSION.md, next-step context → TASK.md.
- **Execution-time headers** — `TASK.md` and inbox entries accept an optional
  `Execute at: <ISO-8601>` or `Execute when: <shell condition>`; **absent =
  immediate**. The driver parks the loop (logged) until the time is reached or
  the condition succeeds.
- **Wait interrupt (default)** — a new inbox entry while the driver is parked
  in a wait ends the wait immediately (`wait_interrupted` in events.jsonl);
  the entry is drained and routed to the parent on the next round. The inbox
  always wins over the schedule.
- **Hot path (opt-in, `steerOnInbox`)** — new inbox entries while the worker
  runs steer the live worker session; `priority: stop` in an entry aborts it.
- **events.jsonl** — append-only `{ts, event, detail}` log of every driver
  action (task start, worker settle/timeout, verify, review, archive, inbox
  drain, wait begin/end/interrupt). `status` renders the last events and the
  current
  phase: `run — worker (task 3)` or `wait until … (remaining hh:mm:ss)`.

## Relay driver (pi-web)

The pi-web relay method is the same pattern with the parent eliminated:
the chain of sessions IS the loop. File mapping:

| Endless-loop file | Relay packet file | Role |
|---|---|---|
| MISSION.md | `charter.md` | goal, finish line, sizing, policies (stable agreement) |
| STATE.md | `status.md` | durable state + the baton (position, next task) |
| TASK.md | folded into `status.md` | "current or next task" |
| history/ | `log.md` | append-only leg history (targeted reads only) |

Default relay root: `.pi-web/relays/<name>/`.

Key differences from the parent-driven variants:

- **No referee.** The next runner is the first to see the previous leg's
  result. Encode verification in the charter: "first thing each leg does:
  verify the previous leg's claimed state against reality".
- **Fire-and-forget handoff.** A leg spawns the next leg exactly once, at the
  end, after all work is durable. It never sees or steers the next leg.
- **Human intervention is via the files.** A watching user changes direction
  by editing charter/status, or a leg raises the intervention signal and
  stops.
- **Charter authority.** The charter owns the finish line; status owns the
  position. A leg that would redefine the finish line must stop and raise
  the intervention signal.

When preparing a relay, the `relay` skill (bundled with pi-web) defines the
exact charter slots, handoff prompt format, and smells to watch for — follow
it; do not invent sizing or task-selection policies.

## Scaffolding a new mission

1. Create `missions/<name>/` with the four files plus an empty `history/`.
2. MISSION.md: goal, constraints, exit criteria, loop protocol (from above).
3. STATE.md: Digest, Learnings, Decisions, Open questions — seeded or empty.
4. TASK.md: task #1 objective.
5. CURRENT.md: one line `# task 1 — not started`.
6. Run the parent loop.
