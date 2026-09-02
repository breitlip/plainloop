/**
 * plainloop extension — slash command + tool for driving plainloop missions
 * from inside pi (TUI, RPC, pi-web).
 *
 *   /plainloop status <mission>           show mission status (mission required)
 *   /plainloop run <mission> [--max N] [--dry-run]   (alias: start)
 *   /plainloop stop [mission]              stop a running mission
 *   /plainloop help
 *
 * `run` starts the driver as a detached background process (the driver
 * writes <mission>/.plainloop.pid); the session stays responsive and a
 * notification is posted when the run finishes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.resolve(here, "..", "driver.mjs");
const NODE = process.execPath;

export default function plainloop(pi: ExtensionAPI) {
  // ------------------------------------------------------------------ utils

  const pidFileOf = (mission: string) => path.join(mission, ".plainloop.pid");

  function livePid(mission: string): number | null {
    const f = pidFileOf(mission);
    if (!existsSync(f)) return null;
    const pid = Number(readFileSync(f, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0); // raises if not alive
      return pid;
    } catch {
      return null;
    }
  }

  type MissionResolution =
    | { ok: true; mission: string }
    | { ok: false; error: string; list?: string[] };

  function missionLine(mission: string, cwd: string): string {
    const rel = path.relative(cwd, mission);
    const pid = livePid(mission);
    return `${rel || mission}${pid ? " [running]" : " [idle]"}`;
  }

  function listMissions(
    cwd: string,
  ): { ok: true; lines: string[] } | { ok: false; error: string } {
    const root = path.join(cwd, "missions");
    if (!existsSync(root)) return { ok: false, error: `no ./missions/ directory in ${cwd}` };
    const missions = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, "MISSION.md")))
      .map((e) => path.join(root, e.name));
    if (missions.length === 0) return { ok: false, error: `no missions (with MISSION.md) in ${root}` };
    return { ok: true, lines: missions.map((m) => missionLine(m, cwd)) };
  }

  function resolveMission(arg: string | undefined, cwd: string): MissionResolution {
    if (arg) {
      const m = path.resolve(cwd, arg);
      if (existsSync(path.join(m, "MISSION.md"))) return { ok: true, mission: m };
      return { ok: false, error: `no MISSION.md in ${m}` };
    }
    const root = path.join(cwd, "missions");
    if (!existsSync(root))
      return { ok: false, error: "no mission given and no ./missions/ directory here" };
    const missions = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, "MISSION.md")))
      .map((e) => path.join(root, e.name));
    if (missions.length === 0) return { ok: false, error: `no missions (with MISSION.md) in ${root}` };
    if (missions.length === 1) return { ok: true, mission: missions[0] };
    return {
      ok: false,
      error: "multiple missions found — pass one explicitly",
      list: missions.map((m) => missionLine(m, cwd)),
    };
  }

  function runStatus(mission: string): string {
    const r = spawnSync(NODE, [DRIVER, "status", mission], { encoding: "utf8" });
    const out = (r.stdout || "").trim();
    const err = (r.stderr || "").trim();
    return out + (err ? `\n${err}` : "");
  }

  function runList(mission: string): string {
    const r = spawnSync(NODE, [DRIVER, "list", mission], { encoding: "utf8" });
    const out = (r.stdout || "").trim();
    const err = (r.stderr || "").trim();
    return out + (err ? `\n${err}` : "");
  }

  function versionInfo(): string {
    const pkgDir = path.resolve(here, "..");
    let version = "unknown";
    try {
      const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      if (pkg.version) version = String(pkg.version);
    } catch {
      /* no package.json next to the extension */
    }
    let ref = "";
    try {
      const r = spawnSync("git", ["-C", pkgDir, "log", "-1", "--format=%h"], { encoding: "utf8" });
      const h = (r.stdout || "").trim();
      if (h) ref = ` (${h})`;
    } catch {
      /* not a git checkout (e.g. npm install) */
    }
    return `plainloop ${version}${ref} — ${pkgDir}`;
  }

  function startRun(
    mission: string,
    opts: { max?: number; dryRun?: boolean },
    notify: (text: string, kind?: "info" | "error" | "warning") => void,
    cwd: string,
  ): { ok: boolean; text: string } {
    const existing = livePid(mission);
    if (existing)
      return { ok: false, text: `already running (pid ${existing}) — stop it first: /plainloop stop ${mission}` };

    const args = [DRIVER, "run", mission];
    if (opts.max !== undefined) args.push("--max", String(opts.max));
    if (opts.dryRun) args.push("--dry-run");
    args.push("--verbose");

    // keep the driver's stderr so a crash is diagnosable (was: "ignore")
    let errFd: number | "ignore" = "ignore";
    try {
      errFd = openSync(path.join(mission, "driver.err.log"), "a");
    } catch {
      errFd = "ignore";
    }
    const child = spawn(NODE, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "ignore", errFd],
    });
    child.unref();
    const pid = child.pid;
    child.on("exit", (code) => {
      try {
        rmSync(pidFileOf(mission), { force: true });
      } catch {
        /* driver already cleaned up */
      }
      notify(
        code === 0
          ? `plainloop: run finished (exit 0) — ${path.basename(mission)}`
          : `plainloop: run finished (exit ${code ?? "signal"}) — check ${path.join(mission, "driver.log")}`,
        code === 0 ? "info" : "warning",
      );
    });
    return {
      ok: true,
      text: `started (pid ${pid}) — log: ${path.join(mission, "driver.log")}; stop with /plainloop stop ${mission}`,
    };
  }

  function stopRun(mission: string): { ok: boolean; text: string } {
    const pid = livePid(mission);
    if (!pid) return { ok: false, text: "no running plainloop found for this mission" };
    try {
      process.kill(pid, "SIGTERM");
      // the driver's SIGTERM handler clears the pidfile; remove it as a fallback
      setTimeout(() => {
        try {
          rmSync(pidFileOf(mission), { force: true });
        } catch {
          /* gone already */
        }
      }, 1500).unref?.();
      return { ok: true, text: `sent SIGTERM to pid ${pid}` };
    } catch (e) {
      return { ok: false, text: `kill failed: ${(e as Error).message}` };
    }
  }

  // ------------------------------------------------------------- /plainloop

  pi.registerCommand("plainloop", {
    description:
      "Drive plainloop missions: /plainloop [status|run|stop|list|version|help] [mission] [--max N] [--dry-run]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const flags: Record<string, string> = {};
      const positional: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "--max" && parts[i + 1]) flags.max = parts[++i];
        else if (parts[i] === "--dry-run") flags.dryRun = "1";
        else positional.push(parts[i]);
      }
      const [actionRaw = "status", missionArg] = positional;
      const action = actionRaw === "start" ? "run" : actionRaw;

      const notify = (text: string, kind: "info" | "error" | "warning" = "info") => {
        try {
          ctx.ui.notify(text, kind);
        } catch {
          /* headless mode: nothing to display on */
        }
      };

      if (action === "help") {
        notify(
          [
            "/plainloop status <mission> — mission required; shows liveness, last activity, and a work summary",
            "/plainloop run <mission> [--max N] [--dry-run] — start a background run (alias: start)",
            "/plainloop stop [mission] — stop a running mission",
            "/plainloop list — list the missions under ./missions/ with their status",
            "/plainloop list <mission> — list the mission's pi sessions (to open in pi-web)",
            "/plainloop version — show the installed extension version",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (action === "version") {
        notify(versionInfo(), "info");
        return;
      }

      if (action === "list" && !missionArg) {
        const r = listMissions(ctx.cwd);
        notify(r.ok ? r.lines.join("\n") : r.error, r.ok ? "info" : "error");
        return;
      }

      if (action === "status" && !missionArg) {
        const r = listMissions(ctx.cwd);
        notify(
          `status requires a mission argument${r.ok ? `\n${r.lines.join("\n")}` : ""}`,
          "error",
        );
        return;
      }

      const res = resolveMission(missionArg, ctx.cwd);
      if (!res.ok) {
        notify(res.list ? `${res.error}\n${res.list.join("\n")}` : res.error, "error");
        return;
      }
      const mission = res.mission;

      if (action === "status") {
        notify(runStatus(mission), "info");
        return;
      }
      if (action === "list") {
        notify(runList(mission), "info");
        return;
      }
      if (action === "run") {
        const r = startRun(mission, { max: flags.max ? Number(flags.max) : undefined, dryRun: Boolean(flags.dryRun) }, notify, ctx.cwd);
        notify(r.text, r.ok ? "info" : "error");
        return;
      }
      if (action === "stop") {
        const r = stopRun(mission);
        notify(r.text, r.ok ? "info" : "error");
        return;
      }
      notify(`unknown action "${action}" — try /plainloop help`, "error");
    },
  });

  // ----------------------------------------------------------------- tool

  pi.registerTool({
    name: "plainloop",
    label: "Plainloop",
    description:
      "Drive a plainloop mission (a directory with MISSION.md, STATE.md, TASK.md, history/). " +
      "Actions: 'status' shows progress, liveness, and a work summary (mission " +
      "required); 'run' (alias: 'start') starts a " +
      "background driver run (optionally capped with max iterations) and returns immediately; " +
      "'stop' terminates a running mission; 'list' lists the missions under ./missions/ with " +
      "their status ([running] or [idle]) and relative paths when no mission is given, " +
      "or the mission's pi sessions (parent, task-NNNN, review-NNNN) when a mission is given so " +
      "they can be opened in pi-web; 'version' reports the installed extension version. " +
      "Omit mission to auto-detect the single mission under ./missions/ (for run/stop; " +
      "status requires a mission).",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("run", { description: "Start a background driver run" }),
          Type.Literal("start", { description: "Alias for 'run'" }),
          Type.Literal("status"),
          Type.Literal("stop"),
          Type.Literal("list"),
          Type.Literal("version"),
        ],
        { description: "What to do with the mission ('version' ignores the other parameters)" },
      ),
      mission: Type.Optional(
        Type.String({
          description:
            "Mission directory (absolute or cwd-relative). Omit to auto-detect the single mission under ./missions/.",
        }),
      ),
      max: Type.Optional(
        Type.Number({ description: "Stop this run after N iterations (action=run only)" }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({ description: "Print rendered prompts, spawn nothing (action=run only)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const notify = (text: string, kind: "info" | "error" | "warning" = "info") => {
        try {
          ctx.ui.notify(text, kind);
        } catch {
          /* headless modes: the tool result carries the message */
        }
      };

      const act = params.action === "start" ? "run" : params.action;

      if (act === "version") {
        const text = versionInfo();
        notify(text, "info");
        return { content: [{ type: "text", text }], details: { ok: true } };
      }

      if (act === "list" && !params.mission) {
        const r = listMissions(ctx.cwd);
        const text = r.ok ? r.lines.join("\n") : r.error;
        notify(text, r.ok ? "info" : "error");
        return { content: [{ type: "text", text }], details: { ok: r.ok } };
      }

      if (act === "status" && !params.mission) {
        const r = listMissions(ctx.cwd);
        const text = `status requires a mission argument${r.ok ? `\n${r.lines.join("\n")}` : ""}`;
        notify(text, "error");
        return { content: [{ type: "text", text }], details: { ok: false } };
      }

      const res = resolveMission(params.mission, ctx.cwd);
      if (!res.ok) {
        const text = res.list ? `${res.error}\n${res.list.join("\n")}` : res.error;
        notify(text, "error");
        return { content: [{ type: "text", text }], details: { ok: false } };
      }
      const mission = res.mission;

      let text: string;
      let ok = true;
      if (act === "status") {
        text = runStatus(mission);
      } else if (act === "list") {
        text = runList(mission);
      } else if (act === "run") {
        const r = startRun(mission, { max: params.max, dryRun: params.dryRun }, notify, ctx.cwd);
        text = r.text;
        ok = r.ok;
      } else {
        const r = stopRun(mission);
        text = r.text;
        ok = r.ok;
      }
      notify(text, ok ? "info" : "error");
      return { content: [{ type: "text", text }], details: { ok, mission } };
    },
  });
}
