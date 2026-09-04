import test from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, isTransientFailure } from "../driver.mjs";

test("backoffDelay doubles per consecutive failure and caps", () => {
  assert.equal(backoffDelay(0, 60, 900), 60);
  assert.equal(backoffDelay(1, 60, 900), 120);
  assert.equal(backoffDelay(2, 60, 900), 240);
  assert.equal(backoffDelay(3, 60, 900), 480);
  assert.equal(backoffDelay(10, 60, 900), 900); // capped
});

test("backoffDelay stays sane with degenerate config", () => {
  assert.equal(backoffDelay(0, 0, 0), 60); // 0 = fall back to defaults
  assert.ok(backoffDelay(5, -10, "abc") >= 1);
});

test("isTransientFailure: infrastructure failures are transient", () => {
  assert.equal(isTransientFailure("worker did not settle"), true);
  assert.equal(isTransientFailure("parent failed: worker: timeout after 600s"), true);
  assert.equal(isTransientFailure("corrective parent failed: timeout after 180s"), true);
  assert.equal(isTransientFailure("pi process exited"), true);
});

test("isTransientFailure: judged-wrong work is semantic", () => {
  assert.equal(isTransientFailure("verify command failed"), false);
  assert.equal(isTransientFailure("reviewer rejected: scope drift"), false);
});

test("isTransientFailure: empty/unknown defaults to transient (retry is safe)", () => {
  assert.equal(isTransientFailure(""), true);
  assert.equal(isTransientFailure(null), true);
});
