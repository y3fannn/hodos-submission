// Real Git remotes in temporary folders only; no GitHub/Azure credentials or writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextReleaseTag, prepareRelease } from "../tools/prepare-release.mjs";

let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS release: ${name}`); };
const date = "20261006";
const root = mkdtempSync(path.join(os.tmpdir(), "hodos-release-"));
const remote = path.join(root, "origin.git"), repo = path.join(root, "working");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (commit, options = {}) => prepareRelease({ cwd: repo, commit, ref: "refs/heads/main", date, ...options });
const remoteTags = () => git(remote, "tag", "--list", "deploy-*", "--sort=version:refname").split("\n").filter(Boolean);
const newCommit = (text) => { writeFileSync(path.join(repo, "app.txt"), text); git(repo, "add", "app.txt"); git(repo, "commit", "-m", text); return git(repo, "rev-parse", "HEAD"); };
const envPath = process.env.PATH;
try {
  mkdirSync(repo);
  git(root, "init", "--bare", remote); git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Release test"); git(repo, "config", "user.email", "release-test@example.invalid");
  git(repo, "remote", "add", "origin", remote);
  const first = newCommit("first"); git(repo, "push", "origin", "main");
  check("non-main and missing main never publish", () => {
    assert.equal(run(first, { ref: "refs/heads/feature" }).status, "skipped");
    assert.equal(run(first, { ref: undefined }).status, "skipped");
    assert.deepEqual(remoteTags(), []);
  });
  check("invalid SHA and wrong checkout fail closed", () => {
    assert.throws(() => run("main"), /exact tested/);
    assert.throws(() => run("0".repeat(40)), /Checkout/);
    assert.deepEqual(remoteTags(), []);
  });
  check("publish and verify the exact tested SHA", () => {
    assert.deepEqual(run(first), { status: "published", tag: "deploy-20261006-1", commit: first });
    assert.equal(git(remote, "rev-parse", "deploy-20261006-1"), first);
  });
  check("rerun creates no duplicate", () => {
    assert.equal(run(first).status, "existing"); assert.equal(remoteTags().length, 1);
  });
  const second = newCommit("second"); git(repo, "push", "origin", "main");
  check("stale tested commit cannot become a new release", () => {
    git(repo, "checkout", "--detach", first);
    assert.equal(run(first).status, "skipped"); assert.equal(remoteTags().length, 1);
    git(repo, "checkout", "main");
  });
  git(repo, "tag", "-a", "deploy-20261006-9", first, "-m", "existing annotated release");
  git(repo, "push", "origin", "refs/tags/deploy-20261006-9");
  check("numbering passes 9 and handles annotated tags", () => {
    assert.equal(run(second).tag, "deploy-20261006-10");
    assert.equal(git(remote, "rev-parse", "deploy-20261006-10"), second);
  });
  git(repo, "tag", "deploy-20261006-11", first); git(repo, "push", "origin", "refs/tags/deploy-20261006-11");
  check("rerun does not override a later manual rollback tag", () => {
    assert.equal(run(second).status, "existing"); assert.equal(remoteTags().at(-1), "deploy-20261006-11");
    assert.equal(git(remote, "rev-parse", "deploy-20261006-11"), first);
  });
  check("dates and counters remain strictly newer", () => {
    assert.equal(nextReleaseTag(["deploy-20261006-99"], "20261007"), "deploy-20261007-1");
    assert.equal(nextReleaseTag(["deploy-20261008-2", "deploy-20261008-10"], date), "deploy-20261008-11");
    assert.equal(nextReleaseTag(["deploy-20261006-99999999999999999999"], date), "deploy-20261006-100000000000000000000");
    assert.throws(() => nextReleaseTag(["deploy-unexpected"], date), /Unexpected/);
    assert.throws(() => nextReleaseTag(["deploy-20261006-01"], date), /Unexpected/);
    assert.throws(() => nextReleaseTag([], "bad date"), /Invalid/);
  });
  const third = newCommit("third"); git(repo, "push", "origin", "main");
  // Compete for our first tag allocation using another real write to the temporary remote.
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = path.join(root, "bin"), marker = path.join(root, "competed"); mkdirSync(bin);
  const wrapper = path.join(bin, "git");
  writeFileSync(wrapper, `#!/usr/bin/env node\nconst {execFileSync,spawnSync}=require('node:child_process');\nconst {existsSync,writeFileSync}=require('node:fs');\nconst args=process.argv.slice(2);\nif(args[0]==='push'&&args[2]?.startsWith('refs/tags/')&&!existsSync(${JSON.stringify(marker)})){\nexecFileSync(${JSON.stringify(realGit)},['-C',${JSON.stringify(remote)},'update-ref',args[2],${JSON.stringify(first)}]);\nwriteFileSync(${JSON.stringify(marker)},'done');\n}\nconst result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});\nprocess.exit(result.status??1);\n`);
  chmodSync(wrapper, 0o755); process.env.PATH = `${bin}${path.delimiter}${envPath}`;
  check("a competing allocation retries without moving its tag", () => {
    assert.equal(run(third).tag, "deploy-20261006-13");
    assert.equal(git(remote, "rev-parse", "deploy-20261006-12"), first);
    assert.equal(git(remote, "rev-parse", "deploy-20261006-13"), third);
  });
  process.env.PATH = envPath;
  const fourth = newCommit("fourth"); git(repo, "push", "origin", "main");
  const hook = path.join(remote, "hooks", "pre-receive"); writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
  check("other push rejections fail without a remote or local release", () => {
    assert.throws(() => run(fourth), /Command failed/);
    assert.equal(remoteTags().at(-1), "deploy-20261006-13");
    assert.equal(git(repo, "tag", "--list", "deploy-20261006-14"), "");
  });
  rmSync(hook);
  check("the actual CI entry point verifies publication and writes the Azure next action", () => {
    const summary = path.join(root, "summary.md");
    const tool = fileURLToPath(new URL("../tools/prepare-release.mjs", import.meta.url));
    const tagsBefore = remoteTags();
    const utcDay = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const before = utcDay();
    const output = execFileSync(process.execPath, [tool], { cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_SHA: fourth, GITHUB_REF: "refs/heads/main", GITHUB_STEP_SUMMARY: summary } });
    // The real CLI uses UTC today, not this test's fixed allocation date; allow midnight rollover.
    const expected = new Set([before, utcDay()].map((day) => nextReleaseTag(tagsBefore, day)));
    const tag = output.match(/^Azure-ready release: (deploy-\d{8}-[1-9]\d*) /)?.[1];
    assert.ok(expected.has(tag), `Unexpected CLI release: ${output}`);
    assert.match(readFileSync(summary, "utf8"), /unchanged saved Azure script/);
    assert.equal(git(remote, "rev-parse", tag), fourth);
  });
  const workflow = readFileSync(fileURLToPath(new URL("../../.github/workflows/pages.yml", import.meta.url)), "utf8");
  const job = workflow.split("  release:\n")[1]?.split("  deploy:\n")[0];
  check("workflow requires passing tests, main and serialized limited write permission", () => {
    assert.ok(job); assert.match(job, /needs: build/); assert.match(job, /if: github\.ref == 'refs\/heads\/main'/);
    assert.match(job, /permissions:\n      contents: write/); assert.match(job, /group: azure-release-tags\n      cancel-in-progress: false/);
    assert.match(job, /ref: \$\{\{ github\.sha \}\}/); assert.match(job, /run: node webapp\/tools\/prepare-release\.mjs/);
    assert.match(workflow, /run: node webapp\/test\/release-tags\.mjs/); assert.ok(workflow.includes('"webapp/tools/**"'));
    assert.doesNotMatch(job, /az vm|ssh |finagent-deploy\.timer|AZURE_|sudo/);
    assert.equal((workflow.match(/contents: write/g) || []).length, 1);
    for (const [, action] of workflow.matchAll(/uses:\s+(\S+)/g)) assert.match(action, /@[a-f0-9]{40}$/);
  });
} finally {
  process.env.PATH = envPath; rmSync(root, { recursive: true, force: true });
}
console.log(`${checks} release checks passed`);
