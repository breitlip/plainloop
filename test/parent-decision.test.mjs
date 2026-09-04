// node --test — parent post-settle decision (decideParentOutcome) and run
// exit-code mapping (runExitCode) in plainloop.mjs.
// Covers: STOP reply → stop; TASK.md exists → proceed; empty reply, no file,
// attempts left → retry; empty reply, no file, budget exhausted → stop with
// "after N attempts"; exit code 0 for good endings, 1 for failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideParentOutcome, runExitCode } from "../plainloop.mjs";

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

test("runExitCode: good endings → 0, failures → 1", () => {
  // good endings: supervise must mark these done, never relaunch
  assert.equal(runExitCode("completed"), 0);
  assert.equal(runExitCode("exit criteria met"), 0);
  assert.equal(runExitCode("parent stop: STOP counter reached 1000"), 0);
  // failures: supervise must relaunch with backoff
  assert.equal(runExitCode("--max 5 reached"), 1);
  assert.equal(runExitCode("parent failed: pi process exited"), 1);
  assert.equal(runExitCode("parent did not write TASK.md after 2 attempts"), 1);
  assert.equal(runExitCode("task 3 failed: verify command failed"), 1);
});
