// Fake `pi --mode rpc` for driver tests. ACKs commands, emits agent_end +
// agent_settled per prompt. Scripted by a per-cwd counter (.fakepi-count):
//   1 -> READY + TASK.md (with `Execute at:` header if FAKE_TASK_HEADER=1,
//        time = now + FAKE_WAIT_MS, default 15000)
//   2 -> READY + TASK.md (no header)
//   3 -> "worker done"
//   4 -> "APPROVE"
//   5 -> "STOP test done"
//   n  -> "OK"
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
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "get_state") {
      out({ type: "response", id: rec.id, success: true });
    } else if (rec.type === "prompt") {
      out({ type: "response", id: rec.id, success: true });
      const stateFile = path.join(process.cwd(), ".fakepi-count");
      let c = 1;
      try {
        c = Number(fs.readFileSync(stateFile, "utf8").trim()) + 1;
      } catch {}
      fs.writeFileSync(stateFile, String(c));
      let reply = "OK";
      if (c === 1) {
        reply = "READY";
        const header = process.env.FAKE_TASK_HEADER
          ? `Execute at: ${new Date(Date.now() + Number(process.env.FAKE_WAIT_MS || 15000)).toISOString()}\n\n`
          : "";
        fs.writeFileSync(path.join(process.cwd(), "TASK.md"), header + "# task\n\nfake task body\n");
      } else if (c === 2) {
        reply = "READY";
        fs.writeFileSync(path.join(process.cwd(), "TASK.md"), "# task\n\nfake task body (inbox routed)\n");
      } else if (c === 3) reply = "worker done";
      else if (c === 4) reply = "APPROVE";
      else if (c === 5) reply = "STOP test done";
      // real pi ACKs immediately and emits events after processing — keep
      // them in separate pipe chunks so the driver's since-cursor race can't
      // swallow agent_settled
      setTimeout(() => {
        out({ type: "agent_end", messages: [{ role: "assistant", content: reply }] });
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
