import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const out = mkdtempSync(join(tmpdir(), "dispatcher-package-"));
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
const info = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", out],
    { encoding: "utf8" },
  ),
)[0];
const paths = info.files.map((f) => f.path);
for (const required of [
  "dist/src/cli.js",
  "README.md",
  "LICENSE",
  "docs/reference.md",
]) {
  if (!paths.includes(required)) throw new Error(`Package missing ${required}`);
}
for (const path of paths) {
  if (
    /node_modules|^tests\/|^state\/|\.sqlite|\.log$|config\.local|\.env/.test(
      path,
    )
  )
    throw new Error(`Private/development file in package: ${path}`);
  const content = readFileSync(path, "utf8");
  if (/\/Users\/[A-Za-z]|-----BEGIN .*PRIVATE KEY-----/.test(content))
    throw new Error(`Personal path or private key in ${path}`);
}
const archive = join(out, info.filename);
const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${hash}  ${info.filename}\n`);
const install = join(out, "install");
mkdirSync(install);
writeFileSync(join(install, "package.json"), '{"private":true}');
execFileSync(
  "npm",
  [
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archive,
  ],
  { cwd: install, stdio: "inherit" },
);
const bin = join(install, "node_modules/.bin/agent-dispatcher");
const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
if (version !== info.version) throw new Error("Installed CLI version mismatch");
execFileSync(bin, ["--help"], { stdio: "ignore" });
console.log(
  JSON.stringify(
    {
      archive,
      checksum: `${archive}.sha256`,
      files: paths.length,
      installedVersion: version,
    },
    null,
    2,
  ),
);
