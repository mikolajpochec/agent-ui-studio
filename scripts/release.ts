#!/usr/bin/env bun
// Maintainers: cut a release. See RELEASING.md.
//   bun scripts/release.ts patch|minor|major|X.Y.Z
// Moves the "Unreleased" changelog notes under the new version, writes VERSION, commits, tags vX.Y.Z, pushes main
// with the tag and publishes a GitHub release with those notes (needs `gh`).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version, compare, SKILL_ROOT, REPO } from "./version.ts";

const die = (m: string): never => { console.error(m); process.exit(1); };
const run = (cmd: string[], quiet = false) => {
  const r = Bun.spawnSync(cmd, { cwd: SKILL_ROOT, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) die(`${cmd.join(" ")} failed:\n${r.stderr.toString()}`);
  const out = r.stdout.toString().trim();
  if (!quiet && out) console.log(out);
  return out;
};

const arg = process.argv[2] || die("usage: bun scripts/release.ts patch|minor|major|X.Y.Z");
const cur = version();
const [ma, mi, pa] = cur.split(".").map(Number);
const next = arg === "major" ? `${ma + 1}.0.0` : arg === "minor" ? `${ma}.${mi + 1}.0` : arg === "patch" ? `${ma}.${mi}.${pa + 1}` : arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) die(`not a version: ${next}`);
if (compare(next, cur) <= 0 && cur !== "0.0.0") die(`${next} is not newer than ${cur}`);

if (run(["git", "rev-parse", "--abbrev-ref", "HEAD"], true) !== "main") die("release from main");
if (run(["git", "status", "--porcelain"], true)) die("commit or stash your changes first");
run(["git", "fetch", "--quiet", "origin"], true);
if (run(["git", "rev-list", "--count", "HEAD..origin/main"], true) !== "0") die("main is behind origin; pull first");

const logFile = join(SKILL_ROOT, "CHANGELOG.md");
const log = readFileSync(logFile, "utf8");
const m = log.match(/^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m) || die("CHANGELOG.md has no '## Unreleased' section");
const notes = m[1].trim() || die("nothing under '## Unreleased' in CHANGELOG.md");
const date = new Date().toLocaleDateString("sv-SE"); // local YYYY-MM-DD
writeFileSync(logFile, log.replace(m[0], `## Unreleased\n\n## ${next} (${date})\n\n${notes}\n\n`));
writeFileSync(join(SKILL_ROOT, "VERSION"), next + "\n");

run(["git", "add", "CHANGELOG.md", "VERSION"]);
run(["git", "commit", "--quiet", "-m", `Release ${next}`]);
run(["git", "tag", "-a", `v${next}`, "-m", `UI Studio ${next}`]);
run(["git", "push", "--quiet", "origin", "main", `v${next}`]);
run(["gh", "release", "create", `v${next}`, "--repo", REPO, "--title", `UI Studio ${next}`, "--notes", notes]);
console.log(`released ${next}`);
