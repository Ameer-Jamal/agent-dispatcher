import { test } from "node:test";
import assert from "node:assert/strict";
import { run, identity, sameProcess } from "../src/process.js";
test("bounded subprocess output and timeout terminate work without shell interpretation", async () => {
  const output = await run(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)'],
    { maxBytes: 1024 },
  );
  assert.equal(output.stopReason, "output_limit");
  assert.ok(output.stdout.length <= 1024);
  const timeout = await run(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { timeoutMs: 30 },
  );
  assert.equal(timeout.stopReason, "timeout");
  const literal = await run(process.execPath, [
    "-e",
    "console.log(process.argv[1])",
    "$(echo injected)",
  ]);
  assert.equal(literal.stdout.trim(), "$(echo injected)");
});
test("process identity prevents signalling a reused or unrelated PID", () => {
  const birth = identity(process.pid);
  assert.ok(birth);
  assert.equal(sameProcess(process.pid, birth), true);
  assert.equal(sameProcess(process.pid, "different birth"), false);
});
