#!/usr/bin/env node
/**
 * endless-loop driver — runs a mission loop by steering pi sessions over RPC.
 *
 * Architecture:
 *   driver (this script, no LLM context)
 *     ├─ parent:  one long-lived `pi --mode rpc` session — writes TASK.md,
 *     │           diagnoses failures, gets compacted every N iterations
 *     └─ worker:  one `pi --mode rpc` session per task — executes TASK.md,
 *                 steered on timeout, aborted if it does not settle
 *
 * The mission directory contract:
 *   MISSION.md   invariant goal/constraints/protocol (sessions read-only)
 *   STATE.md     durable state (sessions update per TASK.md)
 *   TASK.md      current task brief (parent writes, worker executes)
 *   CURRENT.md   worker scratch
 *   history/     completed task briefs: TASK-0001.md, ...
 *   driver.json  machine-readable driver contract (see README.md)
 *
 * Usage:
 *   node driver.mjs run <mission-dir> [--max N] [--dry-run] [--verbose]
 *   node driver.mjs status <mission-dir>
 */

import { spawn, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const PI_BIN = process.env.PI_BIN ?? "pi";

/** Live RPC sessions, so signals can reap them. */
const liveSessions = new Set();

let cleanupDone = false;
let currentPidFile = null;
function shutdown(code) {
  if (cleanupDone) return;
  cleanupDone = true;
  if (currentPidFile) {
    try {
      rmSync(currentPidFile, { force: true });
    } catch {
      /* best effort */
    }
  }
  for (const s of liveSessions) {
    try {
      s.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(143));
process.on("SIGINT", () => shutdown(130));

// ---------------------------------------------------------------------------
// driver.json contract
// ---------------------------------------------------------------------------

const DEFAULTS = {
  workerPrompt:
    "Mission dir: {{dir}}. Read MISSION.md, STATE.md, TASK.md and follow the " +
    "loop protocol in MISSION.md exactly. Do only the TASK.md objective. " +
    "Update CURRENT.md as you go, and before finishing update STATE.md as " +
    "required by TASK.md. Do not edit MISSION.md.",
  taskPrompt:
    "You are the parent of an endless-loop mission. Mission dir: {{dir}}. " +
    "Read MISSION.md, STATE.md, and the most recent files in history/. " +
    "Write TASK.md for task {{n}}: one small objective, context pointers, " +
    "required STATE.md updates. If the mission is complete or cannot " +
    "continue, do NOT write TASK.md and reply exactly: STOP <reason>. " +
    "Otherwise write TASK.md and reply exactly: READY.",
  verify: null, // shell command, run in mission dir; template vars allowed
  exit: null, // shell command, run in mission dir; success => mission done
  countPattern: null, // regex with one capture group, matched in STATE.md
  compactEvery: 5,
  compactInstructions:
    "Preserve: mission dir, current mission state, next task number, " +
    "loop protocol status, and any open failures.",
  workerTimeoutSec: 240,
  steerGraceSec: 60,
  maxRetries: 1,
  review: true,
  reviewTimeoutSec: 120,
  reviewPrompt:
    "You are the independent read-only reviewer for task {{n}} of the mission " +
    "in {{dir}}. Read MISSION.md, STATE.md, TASK.md, CURRENT.md, and the most " +
    "recent files in history/. Judge whether the worker actually completed the " +
    "TASK.md objective and its required STATE.md updates, without scope drift. " +
    "You cannot modify files. Reply exactly: APPROVE, or REJECT <reason>.",
};

function loadDriverConfig(missionDir) {
  const file = path.join(missionDir, "driver.json");
  let raw = {};
  if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf8"));
  return { ...DEFAULTS, ...raw };
}

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function render(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (m, k) =>
    vars[k] === undefined ? m : String(vars[k]),
  );
}

function sh(cmd, cwd) {
  try {
    execSync(cmd, { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function shOutput(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** Nearest git worktree root at or above dir ("" if none). */
function gitRoot(dir) {
  return shOutput("git rev-parse --show-toplevel", dir);
}

function historyTasks(missionDir) {
  const dir = path.join(missionDir, "history");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^TASK-\d+\.md$/.test(f))
    .sort()
    .map((f) => f.replace(/^TASK-(\d+)\.md$/, (m, d) => Number(d)));
}

function logLine(missionDir, line, verbose) {
  const stamp = new Date().toISOString();
  const msg = `${stamp} ${line}\n`;
  appendFileSync(path.join(missionDir, "driver.log"), msg);
  if (verbose) process.stdout.write(msg);
}

// ---------------------------------------------------------------------------
// pi RPC client (JSONL over stdin/stdout, LF-framed)
// ---------------------------------------------------------------------------

class RpcSession {
  constructor({ name, cwd, label, verbose, excludeTools }) {
    this.name = name;
    this.cwd = cwd;
    this.label = label;
    this.verbose = verbose;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.events = [];
    this.eventWaiters = [];
    this.alive = false;

    const args = ["--mode", "rpc", "--name", name];
    if (excludeTools?.length)
      args.push("--exclude-tools", excludeTools.join(","));
    this.proc = spawn(
      PI_BIN,
      args,
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.alive = true;
    liveSessions.add(this);
    this.proc.on("exit", () => {
      this.alive = false;
      for (const { reject } of this.pending.values())
        reject(new Error(`${label}: pi process exited`));
      this.pending.clear();
    });
    this.proc.stderr.on("data", (d) => {
      if (verbose) process.stderr.write(`[${label} stderr] ${d}`);
    });

    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d.toString();
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // non-JSON noise
        }
        if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
          const { resolve } = this.pending.get(rec.id);
          this.pending.delete(rec.id);
          resolve(rec);
        } else {
          this.events.push(rec);
          for (const w of this.eventWaiters) w(rec);
        }
      }
    });
  }

  send(command, timeoutMs = 0) {
    const id = `req-${this.nextId++}`;
    const rec = { ...command, id };
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`${this.label}: timeout after ${timeoutMs / 1000}s`));
          }
        }, timeoutMs).unref?.();
      }
    });
    this.proc.stdin.write(JSON.stringify(rec) + "\n");
    return p;
  }

  /** Send a command and require success:true (the ACK). */
  async sendOk(command, timeoutMs = 0) {
    const rec = await this.send(command, timeoutMs);
    if (rec.success === false) {
      throw new Error(
        `${this.label}: ${command.type} failed: ${JSON.stringify(rec.error ?? rec).slice(0, 300)}`,
      );
    }
    return rec;
  }

  /** Wait until the pi process accepts commands (startup can take a moment). */
  async waitForReady(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.sendOk({ type: "get_state" }, 5_000);
        return;
      } catch (e) {
        if (!this.alive) throw new Error(`${this.label}: pi process died during startup`);
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /**
   * Send a prompt and wait for the run to fully settle.
   * NOTE: the prompt *response* is only an ACK — completion is the
   * `agent_settled` event. Returns the last assistant text of the run.
   */
  async prompt(message, timeoutMs = 0) {
    await this.sendOk({ type: "prompt", message }, 10_000);
    const since = this.events.length;
    try {
      await this.waitForEventSince("agent_settled", since, timeoutMs);
    } catch (e) {
      throw new Error(`${this.label}: prompt did not settle: ${e.message}`);
    }
    return this.lastAssistantTextSince(since);
  }

  /** Wait until an event of the given type arrives at index >= since. */
  waitForEventSince(type, since, timeoutMs = 0) {
    const existing = this.events.slice(since).find((e) => e.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = (rec) => {
        if (rec.type !== type) return;
        this.eventWaiters = this.eventWaiters.filter((x) => x !== w);
        resolve(rec);
      };
      this.eventWaiters.push(w);
      if (timeoutMs > 0)
        setTimeout(() => {
          this.eventWaiters = this.eventWaiters.filter((x) => x !== w);
          reject(new Error(`${this.label}: event timeout (${type})`));
        }, timeoutMs).unref?.();
    });
  }

  /** Text of the last assistant message in agent_end events at index >= since. */
  lastAssistantTextSince(since) {
    for (let i = this.events.length - 1; i >= since; i--) {
      const ev = this.events[i];
      if (ev.type !== "agent_end" || !Array.isArray(ev.messages)) continue;
      for (let j = ev.messages.length - 1; j >= 0; j--) {
        const m = ev.messages[j];
        if (m.role !== "assistant") continue;
        const c = m.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c))
          return c
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n");
      }
    }
    return "";
  }

  kill() {
    liveSessions.delete(this);
    if (this.alive) this.proc.kill("SIGTERM");
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus(missionDir, cfg) {
  const done = historyTasks(missionDir);
  const state = existsSync(path.join(missionDir, "STATE.md"))
    ? readFileSync(path.join(missionDir, "STATE.md"), "utf8")
    : "";
  const count = cfg.countPattern
    ? (state.match(new RegExp(cfg.countPattern)) ?? [])[1]
    : undefined;
  console.log(`mission:      ${missionDir}`);
  console.log(`completed:    ${done.length} tasks${count !== undefined ? ` (count: ${count})` : ""}`);
  console.log(`next task:    ${done.length + 1}`);
  if (existsSync(path.join(missionDir, "TASK.md")))
    console.log(`TASK.md:      present (task ${done.length + 1} brief)`);
  if (existsSync(path.join(missionDir, "driver.log")))
    console.log(`driver.log:   ${statSync(path.join(missionDir, "driver.log")).size} bytes`);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun(missionDir, opts) {
  const cfg = loadDriverConfig(missionDir);
  const verbose = opts.verbose;
  const t0 = Date.now();

  if (!existsSync(path.join(missionDir, "MISSION.md")))
    throw new Error(`no MISSION.md in ${missionDir}`);
  mkdirSync(path.join(missionDir, "history"), { recursive: true });

  const missionName = path.basename(missionDir);
  // pi sessions are keyed by cwd — use the repo root (or driver.json
  // `sessionCwd`) so loop sessions show up under the project in pi-web.
  const sessionCwd =
    cfg.sessionCwd ?? (gitRoot(missionDir) || missionDir);
  if (sessionCwd !== missionDir)
    logLine(missionDir, `session cwd: ${sessionCwd}`, verbose);
  const vars = () => {
    const done = historyTasks(missionDir);
    const state = existsSync(path.join(missionDir, "STATE.md"))
      ? readFileSync(path.join(missionDir, "STATE.md"), "utf8")
      : "";
    const count = cfg.countPattern
      ? Number((state.match(new RegExp(cfg.countPattern)) ?? [])[1] ?? 0)
      : done.length;
    return {
      dir: missionDir,
      n: done.length + 1,
      count,
      next: count + 1,
    };
  };

  const exitMet = () =>
    cfg.exit !== null && sh(render(cfg.exit, vars()), missionDir);

  if (opts.dryRun) {
    const v = vars();
    console.log(`dry-run: next task ${v.n} (count ${v.count})`);
    console.log(`  exit met now: ${cfg.exit ? exitMet() : "(no exit check)"}`);
    console.log(`  task prompt:  ${render(cfg.taskPrompt, v)}`);
    console.log(`  worker prompt:${render(cfg.workerPrompt, v)}`);
    console.log(`  verify:       ${cfg.verify ?? "(none — parent decides)"}`);
    console.log(`  exit:         ${cfg.exit ?? "(none — parent decides)"}`);
    return 0;
  }

  if (exitMet()) {
    logLine(missionDir, "exit criteria already met — nothing to do", verbose);
    return 0;
  }

  // pidfile so `/plainloop stop` (or a human) can find this run
  const pidFile = path.join(missionDir, ".plainloop.pid");
  currentPidFile = pidFile;
  writeFileSync(pidFile, String(process.pid));
  const clearPid = () => {
    try {
      rmSync(pidFile, { force: true });
    } catch {}
  };

  logLine(
    missionDir,
    `run started (max=${opts.max ?? "∞"}, workerTimeout=${cfg.workerTimeoutSec}s)`,
    verbose,
  );

  const parent = new RpcSession({
    name: `plainloop-parent-${missionName}`,
    cwd: sessionCwd,
    label: "parent",
    verbose,
  });
  try {
    await parent.waitForReady();
  } catch (e) {
    parent.kill();
    throw new Error(`parent session failed to start: ${e.message}`);
  }

  let iterations = 0;
  let stopReason = "completed";
  try {
    while (true) {
      if (opts.max !== undefined && iterations >= opts.max) {
        stopReason = `--max ${opts.max} reached`;
        break;
      }
      if (exitMet()) {
        stopReason = "exit criteria met";
        break;
      }

      const v = vars();
      const n = v.n;
      logLine(missionDir, `task ${n}: parent writing TASK.md …`, verbose);

      // --- parent: write the task brief -----------------------------------
      let parentSaid = "";
      try {
        parentSaid = await parent.prompt(render(cfg.taskPrompt, v), 180_000);
      } catch (e) {
        logLine(missionDir, `task ${n}: parent failed: ${e.message}`, verbose);
        stopReason = `parent failed: ${e.message}`;
        break;
      }
      if (/^\s*STOP\b/i.test(parentSaid)) {
        logLine(missionDir, `task ${n}: parent stopped the loop: ${parentSaid.slice(0, 200)}`, verbose);
        stopReason = `parent: ${parentSaid.trim().slice(0, 200)}`;
        break;
      }
      const taskFile = path.join(missionDir, "TASK.md");
      if (!existsSync(taskFile)) {
        logLine(missionDir, `task ${n}: parent did not write TASK.md — stopping`, verbose);
        stopReason = "parent did not write TASK.md";
        break;
      }

      // --- attempt loop: worker → verify → review ---------------------------
      const workerTimeoutMs = cfg.workerTimeoutSec * 1000;
      let taskOk = false;
      let failure = "";
      for (let attempt = 0; attempt <= cfg.maxRetries && !taskOk; attempt++) {
        // -- worker -----------------------------------------------------------
        const worker = new RpcSession({
          name: `plainloop-task-${String(n).padStart(4, "0")}-${missionName}`,
          cwd: sessionCwd,
          label: `worker-${n}${attempt ? `-${attempt}` : ""}`,
          verbose,
        });
        const wStart = Date.now();
        let workerSettled = false;
        try {
          await worker.waitForReady();
          await worker.prompt(render(cfg.workerPrompt, v), workerTimeoutMs);
          workerSettled = true;
          logLine(
            missionDir,
            `task ${n}: worker settled in ${((Date.now() - wStart) / 1000).toFixed(1)}s`,
            verbose,
          );
        } catch (e) {
          logLine(
            missionDir,
            `task ${n}: worker ${e.message} — steering …`,
            verbose,
          );
          // steer once, wait for settle within the grace period
          try {
            await worker.sendOk(
              {
                type: "steer",
                message:
                  "You are taking too long. Stop what you are doing, finish the " +
                  "minimal required STATE.md update for TASK.md, and end your turn.",
              },
              15_000,
            );
            await worker.waitForEventSince("agent_settled", 0, cfg.steerGraceSec * 1000);
            workerSettled = true; // steered to completion; checks will judge the result
            logLine(missionDir, `task ${n}: worker settled after steer`, verbose);
          } catch {
            /* steering failed or did not settle in time */
          }
        }
        // session file is persisted; no more commands for this worker
        worker.kill();
        if (!workerSettled) failure = "worker did not settle";

        // -- verify (deterministic, against the count captured before this task) --
        if (workerSettled && cfg.verify) {
          if (sh(render(cfg.verify, v), missionDir)) {
            logLine(missionDir, `task ${n}: verify OK`, verbose);
          } else {
            logLine(missionDir, `task ${n}: verify FAILED (attempt ${attempt + 1})`, verbose);
            failure = "verify command failed";
          }
        }

        // -- review (independent, read-only) ---------------------------------
        if (workerSettled && !failure && cfg.review) {
          const reviewer = new RpcSession({
            name: `plainloop-review-${String(n).padStart(4, "0")}-${missionName}`,
            cwd: sessionCwd,
            label: `review-${n}${attempt ? `-${attempt}` : ""}`,
            verbose,
            excludeTools: ["bash", "edit", "write"],
          });
          let verdict = "";
          try {
            await reviewer.waitForReady();
            verdict = await reviewer.prompt(
              render(cfg.reviewPrompt, v),
              cfg.reviewTimeoutSec * 1000,
            );
          } catch (e) {
            logLine(
              missionDir,
              `task ${n}: reviewer unavailable (${e.message}) — verify already passed, continuing`,
              verbose,
            );
          } finally {
            reviewer.kill();
          }
          if (/^\s*REJECT\b/i.test(verdict)) {
            logLine(
              missionDir,
              `task ${n}: reviewer REJECTED (attempt ${attempt + 1}): ${verdict.trim().slice(0, 200)}`,
              verbose,
            );
            failure = `reviewer rejected: ${verdict.trim().slice(0, 200)}`;
          } else if (verdict) {
            logLine(missionDir, `task ${n}: reviewer APPROVED`, verbose);
          }
        }

        if (failure === "") {
          taskOk = true;
          break;
        }

        // -- corrective parent before the next attempt ------------------------
        if (attempt < cfg.maxRetries) {
          logLine(
            missionDir,
            `task ${n}: parent writing corrective TASK.md (${failure}) …`,
            verbose,
          );
          try {
            await parent.prompt(
              `Task ${n} failed: ${failure}. Inspect CURRENT.md and STATE.md in ` +
                `${missionDir}, diagnose, and write a corrected, smaller TASK.md ` +
                `for task ${n}. Reply exactly: READY.`,
              180_000,
            );
          } catch (pe) {
            logLine(missionDir, `task ${n}: corrective parent failed: ${pe.message}`, verbose);
            stopReason = `corrective parent failed: ${pe.message}`;
            break;
          }
        }
      }
      if (!taskOk) {
        logLine(
          missionDir,
          `task ${n}: failed after up to ${cfg.maxRetries + 1} attempts: ${failure}`,
          verbose,
        );
        stopReason = `task ${n} failed: ${failure}`;
        break;
      }

      // --- archive ------------------------------------------------------------
      const archiveName = `TASK-${String(n).padStart(4, "0")}.md`;
      renameSync(path.join(missionDir, "TASK.md"), path.join(missionDir, "history", archiveName));
      logLine(missionDir, `task ${n}: archived history/${archiveName}`, verbose);

      iterations++;

      // --- periodic parent compaction ----------------------------------------
      if (iterations % cfg.compactEvery === 0) {
        logLine(missionDir, `parent: compacting (every ${cfg.compactEvery}) …`, verbose);
        try {
          await parent.sendOk(
            { type: "compact", customInstructions: cfg.compactInstructions },
            120_000,
          );
          await parent.waitForEventSince("compaction_end", 0, 120_000).catch(() => {});
          logLine(missionDir, "parent: compaction done", verbose);
        } catch (e) {
          logLine(missionDir, `parent: compaction failed: ${e.message} (continuing)`, verbose);
        }
      }
    }

    logLine(missionDir, `run finished: ${stopReason} (${iterations} iterations, ${((Date.now() - t0) / 1000).toFixed(0)}s)`, verbose);
    console.log(`\ndriver: ${stopReason} — ${iterations} iteration(s) this run`);
    return stopReason === "completed" || stopReason.startsWith("exit") ? 0 : 1;
  } finally {
    clearPid();
    parent.kill();
  }
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

const [, , cmd, ...rest] = process.argv;
const args = [];
const flags = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    flags.push(rest[i]);
    // consume a value token for flags that take one
    if (
      ["--max", "--compact-every", "--timeout"].includes(rest[i]) &&
      i + 1 < rest.length &&
      !rest[i + 1].startsWith("--")
    ) {
      flags.push(rest[++i]);
    }
  } else {
    args.push(rest[i]);
  }
}

function flagValue(name, dflt) {
  const i = flags.indexOf(name);
  return i >= 0 && i + 1 < flags.length ? flags[i + 1] : dflt;
}

try {
  if (cmd === "status" && args[0]) {
    cmdStatus(path.resolve(args[0]), loadDriverConfig(path.resolve(args[0])));
  } else if (cmd === "run" && args[0]) {
    const missionDir = path.resolve(args[0]);
    const code = await cmdRun(missionDir, {
      max: flagValue("--max", undefined) !== undefined
        ? Number(flagValue("--max", 0))
        : undefined,
      dryRun: flags.includes("--dry-run"),
      verbose: flags.includes("--verbose"),
    });
    process.exitCode = code;
  } else {
    console.log(
      "usage:\n" +
        "  node driver.mjs run <mission-dir> [--max N] [--dry-run] [--verbose]\n" +
        "  node driver.mjs status <mission-dir>",
    );
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`driver: ${e.message}`);
  process.exitCode = 1;
}
