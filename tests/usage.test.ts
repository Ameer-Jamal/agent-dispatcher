import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import {
  refreshUsage,
  availability,
  authRejection,
  classifyAuthError,
  providerReadiness,
  subscriptionAuthenticated,
} from "../src/usage.js";
import { parseOutcome } from "../src/adapters.js";
import { submit, runTask, health } from "../src/dispatcher.js";
import { coordinatorInstructions } from "../src/coordinator.js";

const expired =
  "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.";

// Behaviour is read from control.json on every invocation so one test can model login changes.
function provider() {
  const f = fixture();
  const control = join(f.root, "control.json");
  const calls = join(f.root, "provider-calls.jsonl");
  const mock = join(f.root, "mock-provider");
  writeFileSync(
    mock,
    `#!/usr/bin/env node
const fs=require('node:fs');
const c=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='app-server'){
 let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const msg=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(!msg.id)continue;
 if(msg.method==='account/read'&&c.accountError){console.log(JSON.stringify({id:msg.id,error:{message:c.accountError}}));continue;}
 if(msg.method==='account/rateLimits/read'&&c.limitsError){console.log(JSON.stringify({id:msg.id,error:{message:c.limitsError}}));continue;}
 const result=msg.method==='account/read'?{account:{type:'chatgpt',email:'secret@example.com'}}:msg.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:20,resetsAt:Math.floor(Date.now()/1000)+3600}}}:{};
 console.log(JSON.stringify({id:msg.id,result}));}});
}else if(args[0]==='login'){console.error('Logged in using ChatGPT');
}else if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));
}else{
 process.stdin.resume();process.stdin.on('end',()=>{
 if(args[0]==='exec'&&c.execError){console.error(c.execError);console.log(JSON.stringify({type:'turn.failed',error:{message:c.execError}}));process.exitCode=1;return;}
 fs.writeFileSync('worker.txt','worker output\\n');
 if(args[0]==='exec'){console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000001'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done.\\nDISPATCHER_STATUS: completed'}}));}
 else console.log(JSON.stringify({result:'Done.\\nDISPATCHER_STATUS: completed',session_id:'00000000-0000-4000-8000-000000000002'}));
 });
}
`,
    { mode: 0o700 },
  );
  f.config.agents.codex.command = mock;
  f.config.agents.claude.command = mock;
  const set = (value: Record<string, string>) =>
    writeFileSync(control, JSON.stringify(value));
  set({});
  // Bypass the one-minute account-read ceiling between simulated checks.
  const refresh = () => {
    f.store.setMeta("usageAttempt", "0");
    return refreshUsage(f.store, f.config, true);
  };
  const execs = () =>
    readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .filter((l) => JSON.parse(l)[0] === "exec").length;
  return { ...f, set, refresh, execs };
}

test("remote auth rejection survives local login status until a fresh remote check succeeds", async () => {
  const f = provider();
  try {
    f.set({ limitsError: expired });
    await f.refresh();
    assert.equal(f.store.meta("auth:codex"), "false");
    assert.equal(authRejection(f.store, "codex")?.source, "remote-check");
    // Local saved credentials still report ChatGPT login; that must not clear the rejection.
    assert.equal((await availability(f.config, f.store)).codex, false);
    assert.equal((await availability(f.config, f.store)).codex, false);
    assert.equal(subscriptionAuthenticated(f.store).codex, false);
    const ready = providerReadiness(f.store, f.config).codex!;
    assert.equal(ready.ready, false);
    assert.equal(ready.auth, "rejected");
    assert.match(ready.action!, /codex login/);
    const status = JSON.stringify({
      ...health(f.store),
      providers: providerReadiness(f.store, f.config),
      usage: f.store.usage("codex"),
    });
    assert.doesNotMatch(status, /secret@example|could not be refreshed/);
    assert.match(f.store.usage("codex")!.note!, /refresh token expired/);

    f.set({});
    await f.refresh();
    assert.equal(authRejection(f.store, "codex"), undefined);
    assert.equal((await availability(f.config, f.store)).codex, true);
    assert.equal(
      providerReadiness(f.store, f.config).codex!.auth,
      "remote-verified",
    );
    assert.equal(f.store.usage("codex")?.quality, "measured");
  } finally {
    f.cleanup();
  }
});

test("transient account errors stay unknown and do not record a rejection", async () => {
  const f = provider();
  try {
    f.set({ accountError: "stream disconnected before completion" });
    await f.refresh();
    assert.equal(authRejection(f.store, "codex"), undefined);
    assert.equal(f.store.meta("authCheck:codex"), "unverified");
    assert.equal((await availability(f.config, f.store)).codex, true);
    assert.equal(
      providerReadiness(f.store, f.config).codex!.auth,
      "local-only",
    );
    f.set({ limitsError: "refresh token request timed out" });
    await f.refresh();
    assert.equal(authRejection(f.store, "codex"), undefined);
    assert.equal((await availability(f.config, f.store)).codex, true);
    // A later transient error never clears an established rejection.
    f.set({
      limitsError: "unexpected status 401 Unauthorized: workspace routing",
    });
    await f.refresh();
    f.set({ accountError: "Codex account inspection timed out" });
    await f.refresh();
    assert.match(authRejection(f.store, "codex")!.reason, /401/);
    assert.equal((await availability(f.config, f.store)).codex, false);
  } finally {
    f.cleanup();
  }
});

test("auth failures are classified distinctly from transient and task output", () => {
  assert.match(classifyAuthError(expired)!, /refresh token/);
  assert.match(
    classifyAuthError("unexpected status 401 Unauthorized: workspace")!,
    /401/,
  );
  assert.equal(classifyAuthError("stream disconnected; retrying"), undefined);
  assert.equal(classifyAuthError("rate limit reached"), undefined);
  assert.equal(
    classifyAuthError("refresh token request timed out; service unavailable"),
    undefined,
  );
  assert.match(classifyAuthError("refresh_token_expired")!, /refresh token/);
  assert.match(classifyAuthError("invalid_refresh_token")!, /refresh token/);
  const failed = parseOutcome("codex", {
    code: 1,
    stdout: JSON.stringify({
      type: "turn.failed",
      error: { message: expired },
    }),
    stderr: "",
  });
  assert.equal(failed.kind, "availability");
  assert.match(failed.authFailure!, /refresh token/);
  // Worker output discussing HTTP 401 handling is not a provider sign-in failure.
  const unrelated = parseOutcome("codex", {
    code: 1,
    stdout: JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Tests for 401 unauthorized fail" },
    }),
    stderr: "",
  });
  assert.equal(unrelated.authFailure, undefined);
});

test("pinned Codex auth failure blocks without fallback or replay and invalidates readiness", async () => {
  const f = provider();
  try {
    f.set({ execError: `${expired} Account: secret@example.com` });
    const task = submit(f.store, f.config, { ...f.input, prefer: "codex" });
    f.store.update(task.id, { status: "running" });
    await runTask(f.store, f.config, task.id);
    const done = f.store.get(task.id);
    assert.equal(done.status, "blocked");
    assert.equal(done.agent, "codex");
    assert.equal(done.attempts, 1);
    assert.equal(f.execs(), 1);
    assert.match(done.error!, /codex login/);
    assert.doesNotMatch(done.error!, /could not be refreshed/);
    assert.match(done.summary!, /codex login/);
    assert.doesNotMatch(done.summary!, /secret@example|could not be refreshed/);
    assert.equal(authRejection(f.store, "codex")?.source, "worker");
    assert.equal((await availability(f.config, f.store)).codex, false);

    // A later pinned task is refused before any worker starts, with the login action.
    const next = submit(f.store, f.config, {
      ...f.input,
      prefer: "codex",
      idempotencyKey: "pinned-again",
    });
    f.store.update(next.id, { status: "running" });
    await runTask(f.store, f.config, next.id);
    assert.equal(f.store.get(next.id).status, "blocked");
    assert.match(
      f.store.get(next.id).error!,
      /Requested codex unavailable.*codex login/,
    );
    assert.equal(f.execs(), 1);
  } finally {
    f.cleanup();
  }
});

test("automatic routing falls back once after Codex auth failure", async () => {
  const f = provider();
  try {
    f.set({
      execError: "unexpected status 401 Unauthorized: workspace routing",
    });
    const task = submit(f.store, f.config, {
      ...f.input,
      capabilityReason: "fixture",
    });
    f.store.update(task.id, { status: "running" });
    await runTask(f.store, f.config, task.id);
    const done = f.store.get(task.id);
    assert.equal(done.status, "completed");
    assert.equal(done.agent, "claude");
    assert.equal(done.attempts, 2);
    assert.equal(f.execs(), 1);
    assert.match(authRejection(f.store, "codex")!.reason, /401/);
  } finally {
    f.cleanup();
  }
});

test("coordinator instructions do not treat a spawned worker as progress", () => {
  assert.match(coordinatorInstructions, /not proof a model began work/);
  assert.match(coordinatorInstructions, /do not say a worker is investigating/);
});
