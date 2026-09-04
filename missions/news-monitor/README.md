# news-monitor — a scheduled monitor mission

Every 5 minutes (aligned to wall-clock boundaries: 9:00, 9:05, 9:10, ...)
a worker pi session fetches the front page of
https://www.goodnewsnetwork.org, extracts the 5 top stories, and rewrites
`latest.md` in this dir as markdown. Unlike
[count-to-1000](../count-to-1000), this mission has **no exit
criteria** — it is a monitor loop that runs until you stop it (or hit
`--max`). Like count-to-1000 it is **pure markdown — no driver.json**:
the parent judges each outcome from `latest.md`/STATE.md, and the driver
only enforces timeouts, retries, and the archive.

Cycling uses plainloop's built-in **execution-time headers** — no custom
gates:

- The parent stamps each TASK.md (task 2+) with
  `Execute at: <next 5-minute boundary>` (the protocol lives in
  MISSION.md → Scheduling). The driver parks the loop until that moment —
  `status` shows `wait until … (remaining hh:mm:ss)`, and events.jsonl
  logs `wait_start`/`wait_end`. TASK 1 has no header, so the first
  refresh is instant.
- The **worker does the web fetching itself** — pi has web access
  (`fetch_content` / `web_search`). The fetch is described only in the
  prompts (MISSION.md/TASK.md); nothing outside the prompts touches the
  network.
- The **parent judges each outcome** (MISSION.md → Judging the outcome):
  `latest.md` has 5 `## ` headline sections with links and a fresh
  `Last updated:` line; if not, it writes a corrective TASK.md instead of
  moving on.
- A new `INBOX.md` entry interrupts the wait and is routed to the parent
  (inbox always wins over the schedule).

## Try it

```bash
# from the plainloop repo root
node plainloop.mjs run missions/news-monitor --max 3 --verbose
```

`--max 3` caps the demo at 3 refreshes (≈ 10 minutes of wall time).
Watch:

- TASK 2+ carrying an `Execute at:` header, and the driver sitting in
  `wait until …` between iterations (visible in `status` / events.jsonl
  as `wait_start` / `wait_end`)
- `latest.md` rewritten each iteration with the 5 current top stories
- `STATE.md` digest climbing (`iterations:`, `last-updated:`,
  `top-headline:`)
- `events.jsonl` — every driver action, timestamped

Other things to try:

```bash
node plainloop.mjs status missions/news-monitor   # phase + event tail
node plainloop.mjs run missions/news-monitor --dry-run   # print prompts, spawn nothing
node plainloop.mjs stop news-monitor               # stop a running loop
```

From inside pi, just ask: *"run the news-monitor mission for 2
iterations"* — or use `/plainloop run news-monitor --max 2`.

## Files

| File | Who owns it | Role |
|---|---|---|
| `MISSION.md` | parent | goal, the (repeated) task, constraints, loop protocol |
| `STATE.md` | workers | digest: iterations, last-updated, top headline |
| `TASK.md` | parent → worker | the current one-objective brief (same every iteration) |
| `CURRENT.md` | worker | scratch notes, crash recovery |
| `latest.md` | worker | **the artifact** — 5 top stories as markdown |
| `history/` | driver | archived briefs — one file per completed iteration |
| `events.jsonl` | driver | append-only event log |

(No `driver.json` — see the main README for the optional deterministic
`verify`/`exit` gates and other tuning knobs.)
