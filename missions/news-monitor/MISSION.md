# Mission: news-monitor

A monitoring mission: every iteration the worker fetches the front page of
https://www.goodnewsnetwork.org, extracts the 5 top stories, and rewrites
`latest.md` in the mission dir as markdown.

Cycling uses plainloop's built-in execution-time headers: the parent
stamps each TASK.md with `Execute at: <next 5-minute boundary>` and the
driver parks the loop until that time (visible in `status` as
`wait until …`, logged as `wait_start`/`wait_end` in events.jsonl).
Fetching is the worker's own job — the pi session has web access
(`fetch_content` / `web_search`). This mission is **pure markdown** —
no driver.json; nothing outside the prompts touches the network.

## Goal

Keep `latest.md` current: the 5 top stories from
www.goodnewsnetwork.org as markdown (headline, link, 1–2 sentence
summary), refreshed on every iteration.

## The task (identical every iteration)

1. Fetch https://www.goodnewsnetwork.org with your own web tools
   (`fetch_content`; if that fails, fall back to `web_search` for the
   current top stories on the site).
2. Pick the 5 top stories (the lead/featured stories of the front page).
3. Rewrite `latest.md` in the mission dir in this exact format:

   ```markdown
   # Good News Network — Top Stories

   _Last updated: <YYYY-MM-DD HH:MM> · task <n>_

   ## <Headline 1>
   - Link: <url>
   - Summary: <1–2 sentences>

   ## <Headline 2>
   - Link: <url>
   - Summary: <1–2 sentences>

   ... (exactly 5 `##` sections)
   ```

4. Update STATE.md as required by TASK.md.

## Scheduling (parent)

- TASK 1: no `Execute at:` header — run immediately.
- TASK 2 and later: include the line
  `Execute at: <ISO-8601 timestamp>` in TASK.md, naming the next
  5-minute wall-clock boundary (…:00, …:05, …:10, ...) strictly after
  the current time.
- Get the current time precisely before writing the header (e.g.
  `node -e "console.log(new Date().toISOString())"`), then round up to
  the next 5-minute mark.
- A missing header means "run immediately" — always prefer a correct
  header over none.

## Judging the outcome (parent)

There is no driver.json — the parent judges each outcome when writing the
next TASK.md:

- `latest.md` exists, has exactly 5 `## ` headline sections, each with a
  `Link:` and a `Summary:` line, and a fresh `Last updated:` line.
- STATE.md digest was updated as TASK.md required.
- If the outcome is bad, write a corrective TASK.md (still with its
  `Execute at:` header) instead of moving on. Never `STOP` — see
  Exit criteria.

## Constraints

- Each task does exactly one thing: refresh `latest.md`.
- Only `latest.md` and `STATE.md` may change.
- Do not edit MISSION.md. Do not start tangential work.
- If the page cannot be fetched after a reasonable retry, keep the
  existing `latest.md` untouched and note the failure in STATE.md
  (Open questions). Never delete or truncate `latest.md`.

## Exit criteria

None — this is a monitor loop. It runs until stopped
(`plainloop stop news-monitor`) or `--max N` is reached. The parent
always writes the same task; there is no `STOP` condition.

## Loop protocol

1. Read MISSION.md, STATE.md, TASK.md (and CURRENT.md if it exists).
2. Do ONLY the objective in TASK.md. One thing. Small.
3. Update CURRENT.md as you go (scratch notes, partial results).
4. Before finishing: update STATE.md as required by TASK.md.
5. Do NOT edit MISSION.md. Do NOT start tangential work.
6. Finish. The parent takes over.
