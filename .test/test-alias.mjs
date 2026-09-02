// Loads the REAL extension (Node 24 type-stripping) and exercises the
// mission aliases: numbered list, status by number, by name, by path,
// out-of-range, and the tool path.
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const tmp = mkdtempSync(path.join(os.tmpdir(), "pl-alias-"));
for (const name of ["an-id", "another-id"]) {
  const d = path.join(tmp, "missions", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "MISSION.md"), "# mission\n");
}

const ext = (
  await import(pathToFileURL(path.join(REPO, "extensions", "plainloop.ts")).href)
).default;

const commands = {};
const tools = {};
const pi = {
  registerCommand: (name, def) => {
    commands[name] = def;
  },
  registerTool: (def) => {
    tools[def.name] = def;
  },
};
ext(pi);

const out = [];
const ctx = { cwd: tmp, ui: { notify: (t, k) => out.push(`[${k}] ${t}`) } };
const run = async (args) => {
  await commands.plainloop.handler(args, ctx);
};

await run("list");
await run("status 2");
await run("status another-id");
await run("status missions/another-id");
await run("status 99");
await run("status");

const toolRes = await tools.plainloop.execute(
  "t1",
  { action: "status", mission: "1" },
  undefined,
  undefined,
  ctx,
);

console.log(out.join("\n---\n"));
console.log("--- tool: status mission=1 ---");
console.log(toolRes.content[0].text);
rmSync(tmp, { recursive: true, force: true });
console.log("DONE");
