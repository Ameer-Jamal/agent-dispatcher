import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { configSchema, taskSchema } from "../src/config.js";
import { Store } from "../src/store.js";
export function fixture(mode = "success") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dispatcher-test-")));
  const state = join(root, "state"),
    repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@localhost");
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  const mock = join(root, "mock-agent");
  writeFileSync(
    mock,
    `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(join(root, "calls.jsonl"))},JSON.stringify(args)+'\\n');const mode=${JSON.stringify(mode)};
if(args[0]==='app-server'){
 let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const msg=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(!msg.id)continue;
 const result=msg.method==='account/read'?{account:{type:'chatgpt'}}:msg.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:20,resetsAt:Math.floor(Date.now()/1000)+3600},secondary:{usedPercent:25,resetsAt:Math.floor(Date.now()/1000)+7200}}}:{};
 console.log(JSON.stringify({id:msg.id,result}));}});
}else if(args[0]==='status'){console.log('Logged in');
}else if(args[0]==='models'){console.log('No models available for this account.');
}else if(args[0]==='login'){console.error('Logged in using ChatGPT');
}else if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:mode!=='unauthenticated',authMethod:mode==='unauthenticated'?'none':'claude.ai'}));
}else if(args[0]==='add'){fs.writeFileSync(${JSON.stringify(join(root, "schedule.json"))},args.at(-1));console.log(JSON.stringify({id:'snooze-fixture'}));
}else if(args[0]==='events'){console.log(JSON.stringify([{job_id:'snooze-fixture',delivery:'queued'}]));
}else{
 process.stdin.resume();process.stdin.on('end',()=>{
 if(mode==='slow'){setTimeout(()=>console.log(JSON.stringify({result:'Done',session_id:'session'})),30000);return;}
 const codex=args[0]==='exec';
 if(mode==='quota'&&!codex){console.log(JSON.stringify({is_error:true,result:'Usage limit reached'}));process.exitCode=1;return;}
 if(mode==='permission'){console.log(JSON.stringify({result:'Cannot write',permission_denials:[{tool_name:'Write'}]}));return;}
 fs.writeFileSync('worker.txt','worker output\\n');
 if(codex){console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000001'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Implemented worker.txt. File content checked.'}}));}
 else console.log(JSON.stringify({result:'Implemented worker.txt. File content checked.',session_id:'00000000-0000-4000-8000-000000000002',usage:{input_tokens:4,output_tokens:5}}));
 });
}
`,
    { mode: 0o700 },
  );
  const config = configSchema.parse({
    allowedRoots: [repo],
    agents: { codex: { command: mock }, claude: { command: mock } },
    snooze: { command: mock },
  });
  const store = new Store(state);
  writeFileSync(join(state, "config.json"), JSON.stringify(config));
  const input = taskSchema.parse({
    goal: "Create worker.txt",
    cwd: repo,
    idempotencyKey: "fixture-task",
  });
  return {
    root,
    state,
    repo,
    config,
    store,
    input,
    mock,
    git,
    read: (name: string) => readFileSync(join(repo, name), "utf8"),
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export async function eventually(check: () => boolean, timeout = 15000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
