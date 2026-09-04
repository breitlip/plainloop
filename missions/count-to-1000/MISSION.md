# Mission: count-to-1000

A minimal example mission: the loop increments a counter, one step per
iteration. Cheap to run, easy to watch — the whole point is to see how the
plainloop machinery works (parent writes the task, worker executes it, driver
verifies and archives).

## Goal

Increment the counter in STATE.md from 0 to 1000. The mission is complete
when the counter reads 1000.

## Constraints

- Each task does exactly one thing: increment the counter by 1.
- Only the `counter:` line in STATE.md may change.
- Do not edit MISSION.md. Do not start tangential work.

## Exit criteria

The counter in STATE.md is 1000 or more. (The parent checks this and replies
`STOP`.)

## Loop protocol

1. Read MISSION.md, STATE.md, TASK.md (and CURRENT.md if it exists).
2. Do ONLY the objective in TASK.md. One thing. Small.
3. Update CURRENT.md as you go (scratch notes, partial results).
4. Before finishing: update STATE.md with the state changes required by
   TASK.md.
5. Do NOT edit MISSION.md. Do NOT start tangential work.
6. Finish. The parent takes over.
