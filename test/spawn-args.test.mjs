// node --test — pi session spawn args (piSessionArgs) in plainloop.mjs.
// Covers: no model → args end exactly at --name (byte-identical to the
// pre-model-pin behavior); model set → --model <value> appended verbatim
// (provider/id, bare id, thinking suffix); empty string → treated as unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { piSessionArgs } from "../plainloop.mjs";

const NAME = "plainloop-task-0001-demo";

test("no model → no --model flag (byte-identical to pre-model-pin args)", () => {
  const args = piSessionArgs(NAME, null);
  assert.deepEqual(args.slice(-4), ["--mode", "rpc", "--name", NAME]);
  assert.ok(!args.includes("--model"));
  // undefined behaves the same as null (driver.json default)
  assert.deepEqual(piSessionArgs(NAME, undefined), args);
});

test("model set → --model <value> appended verbatim", () => {
  assert.deepEqual(
    piSessionArgs(NAME, "anthropic/claude-sonnet-4-5").slice(-6),
    ["--mode", "rpc", "--name", NAME, "--model", "anthropic/claude-sonnet-4-5"],
  );
});

test("bare id and thinking suffix pass through verbatim", () => {
  assert.deepEqual(
    piSessionArgs(NAME, "sonnet:high").slice(-2),
    ["--model", "sonnet:high"],
  );
  assert.deepEqual(piSessionArgs(NAME, "gpt-5").slice(-2), ["--model", "gpt-5"]);
});

test("empty string model → treated as unset", () => {
  assert.deepEqual(piSessionArgs(NAME, ""), piSessionArgs(NAME, null));
});
