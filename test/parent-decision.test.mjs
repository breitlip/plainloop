// node --test — parent post-settle decision (decideParentOutcome in driver.mjs).
// Covers: STOP reply → stop; TASK.md exists → proceed; empty reply, no file,
// attempts left → retry; empty reply, no file, budget exhausted → stop with
// "after N attempts".
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideParentOutcome } from "../driver.mjs";

test("STOP reply → stop (final, never retried)", () => {
  const d = decideParentOutcome("STOP mission complete", false, 1, 1);
  assert.equal(d.action, "stop");
  assert.equal(d.kind, "stop-reply");
  assert.equal(d.reason, "parent: STOP mission complete");
  // STOP on a later attempt with retries left must still stop immediately.
  const d2 = decideParentOutcome("  stop, budget exhausted", false, 2, 5);
  assert.equal(d2.action, "stop");
  assert.match(d2.reason, /^parent: stop, budget exhausted$/);
});

test("TASK.md exists → proceed", () => {
  assert.equal(decideParentOutcome("READY", true, 1, 1).action, "proceed");
  // thinking-only turn (empty text) but the file was written → proceed
  assert.equal(decideParentOutcome("", true, 2, 1).action, "proceed");
});

test("empty reply, no TASK.md, attempts left → retry", () => {
  const d = decideParentOutcome("", false, 1, 1);
  assert.equal(d.action, "retry");
  assert.equal(d.kind, "no-task");
  assert.equal(d.reason, "no TASK.md");
});

test("empty reply, no TASK.md, budget exhausted → stop with attempts", () => {
  const d = decideParentOutcome("", false, 2, 1);
  assert.equal(d.action, "stop");
  assert.equal(d.kind, "no-task");
  assert.equal(d.reason, "parent did not write TASK.md after 2 attempts");
});

test("parentRetries 0 → single attempt, no retry", () => {
  const d = decideParentOutcome("", false, 1, 0);
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "parent did not write TASK.md after 1 attempt");
});
