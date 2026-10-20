// Called only after CI passes. Publishes a tag, never contacts Azure.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const tagPattern = /^deploy-(\d{8})-([1-9]\d*)$/;

export function nextReleaseTag(tags, date) {
  if (!/^\d{8}$/.test(date)) throw new Error("Invalid release date.");
  let day = date, count = 0n;
  for (const tag of tags) {
    const match = tagPattern.exec(tag);
    if (!match) throw new Error(`Unexpected deploy tag: ${tag}`);
    if (match[1] > day) { day = match[1]; count = BigInt(match[2]); }
    else if (match[1] === day && BigInt(match[2]) > count) count = BigInt(match[2]);
  }
  return `deploy-${day}-${count + 1n}`;
}

export function prepareRelease({ commit, ref, cwd = process.cwd(), date = new Date().toISOString().slice(0, 10).replaceAll("-", "") }) {
  if (ref !== "refs/heads/main") return { status: "skipped", reason: "Only main publishes Azure-ready tags." };
  if (!/^[a-f0-9]{40}$/.test(commit || "")) throw new Error("An exact tested commit SHA is required.");
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const lines = (text) => text ? text.split("\n") : [];
  if (git("rev-parse", "HEAD") !== commit) throw new Error("Checkout does not match the tested commit.");
  for (let attempt = 0; attempt < 3; attempt++) {
    git("fetch", "--quiet", "--tags", "origin");
    const main = git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0];
    if (main !== commit) return { status: "skipped", reason: "Main moved; let the newer run finish its checks." };
    const tags = lines(git("tag", "--list", "deploy-*", "--sort=version:refname"));
    const tag = nextReleaseTag(tags, date);
    const existing = lines(git("tag", "--points-at", commit, "--list", "deploy-*", "--sort=-version:refname"));
    if (existing.length) return { status: "existing", tag: existing[0], commit };
    git("tag", tag, commit);
    try {
      git("push", "origin", `refs/tags/${tag}`);
      const published = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`).split(/\s/)[0];
      if (published !== commit) throw new Error("Published tag does not match the tested commit.");
      return { status: "published", tag, commit };
    } catch (error) {
      // Delete only our unpushed local allocation, never an existing remote tag.
      // If the push succeeded but verification failed, fail rather than retry publication.
      const remote = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`).split(/\s/)[0];
      if (remote === commit) throw error;
      git("tag", "--delete", tag);
      if (!remote) throw error;
    }
  }
  throw new Error("Release allocation conflicted three times; retry the workflow.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = prepareRelease({ commit: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF });
  const message = result.status === "published"
    ? `Azure-ready release: ${result.tag} (${result.commit}). Run your unchanged saved Azure script to deploy it.`
    : result.status === "existing"
      ? `This tested commit already has ${result.tag}; no new tag created. Azure still requires your saved script.`
      : `No release created: ${result.reason}`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
