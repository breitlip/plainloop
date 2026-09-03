// Fake `pi --mode rpc` for the parent-retry acceptance test.
// Scripted by a shared per-cwd prompt counter (.fakepi-count), so the
// parent/worker/reviewer processes line up on one sequence:
//   prompts 1..N            -> thinking-only turn (empty text, NO TASK.md)
//   prompt N+1              -> READY + TASK.md
//   prompt N+2              -> "worker done"
//   prompt N+3              -> "APPROVE"
//   prompt N+4              -> "STOP test done"
// Env:
//   FAKE_PARENT_EMPTY  N (default 1) — parent prompts that settle empty.
//     N=1 → retry succeeds on attempt 2 (acceptance A).
//     N=2 → budget (2 attempts) exhausted (acceptance B).
//   FAKE_PARENT_STOP=1 — first prompt replies STOP immediately.
const fs = require("fs");
const path = require("path");
let buf = "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
process.stdin.on("data", (d) => {
  buf += d.toString();
  for (;;) {
    const idx = buf.indexOf("\n");
    if (idx < 0) break;
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "get_state") {
      out({ type: "response", id: rec.id, success: true });
    } else if (rec.type === "prompt") {
      out({ type: "response", id: rec.id, success: true });
      try {
        fs.appendFileSync(path.join(process.cwd(), ".fakepi-prompts"), rec.message + "\n===\n");
      } catch {}
      const stateFile = path.join(process.cwd(), ".fakepi-count");
      let c = 1;
      try { c = Number(fs.readFileSync(stateFile, "utf8").trim()) + 1; } catch {}
      fs.writeFileSync(stateFile, String(c));
      const N = Number(process.env.FAKE_PARENT_EMPTY ?? 1);
      let reply = "OK";
      let thinkingOnly = false;
      if (process.env.FAKE_PARENT_STOP && c === 1) {
        reply = "STOP done on first try";
      } else if (c <= N) {
        reply = ""; // thinking-only turn: no text part, no TASK.md written
        thinkingOnly = true;
      } else if (c === N + 1) {
        reply = "READY";
        fs.writeFileSync(path.join(process.cwd(), "TASK.md"), "# task\n\nfake task body\n");
      } else if (c === N + 2) reply = "worker done";
      else if (c === N + 3) reply = "APPROVE";
      else if (c === N + 4) reply = "STOP test done";
      setTimeout(() => {
        const messages = thinkingOnly
          ? [{ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(100) }] }]
          : [{ role: "assistant", content: reply }];
        out({ type: "agent_end", messages });
        out({ type: "agent_settled" });
      }, 50);
    } else if (rec.type === "compact") {
      out({ type: "response", id: rec.id, success: true });
      setTimeout(() => out({ type: "compaction_end" }), 50);
    } else if (rec.type === "steer") {
      out({ type: "response", id: rec.id, success: true });
      out({ type: "agent_settled" });
    } else {
      out({ type: "response", id: rec.id, success: true });
    }
  }
});
