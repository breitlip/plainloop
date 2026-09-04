# TASK 1

## Objective

Fetch the front page of https://www.goodnewsnetwork.org and write the 5
top stories to `latest.md` in the mission dir, in the exact format
defined in MISSION.md ("The task" section).

## Context

- Use `fetch_content` on https://www.goodnewsnetwork.org; fall back to
  `web_search` for the site's current top stories if the fetch fails.
- Exactly 5 `##` headline sections, each with a `Link:` and a
  `Summary:` line.
- Title: `# Good News Network — Top Stories`.
- Header line: `_Last updated: <YYYY-MM-DD HH:MM> · task 1_`.

## State updates

- STATE.md Digest: set `iterations: 1`, `last-updated: <timestamp>`,
  `top-headline: <headline 1>`.

## Do-not

- Do not edit MISSION.md.
- Do not delete or truncate an existing `latest.md` unless the new
  content is complete.
