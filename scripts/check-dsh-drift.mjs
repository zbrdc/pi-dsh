#!/usr/bin/env node
/** Drift check between pi-dsh and its pinned DeepSeek Harness commit.
 *
 * Usage: node scripts/check-dsh-drift.mjs [path-to-deepseek-harness] [--update-pin]
 *
 * Verifies every package mapped in dsh-compat.json still exists upstream, then
 * lists upstream commits since the pin that touch mapped packages — that list
 * is the review queue for the semantic reimplementation. Exit codes:
 * 0 = pin is current (or just updated), 1 = drift or missing packages,
 * 2 = usage/environment error. --update-pin rewrites the pin to upstream HEAD;
 * run it only after reviewing the listed commits and porting what applies. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "dsh-compat.json");
const args = process.argv.slice(2).filter((a) => a !== "--update-pin");
const updatePin = process.argv.includes("--update-pin");
const dshDir = resolve(args[0] ?? process.env.DSH_DIR ?? join(root, "..", "deepseek-harness"));

const git = (argv) => execFileSync("git", ["-C", dshDir, ...argv], { encoding: "utf8" }).trim();

if (!existsSync(join(dshDir, ".git"))) {
  console.error(`error: no deepseek-harness checkout at ${dshDir} (pass a path or set DSH_DIR)`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pin = manifest.dsh.commit;
let head;
try {
  head = git(["rev-parse", "HEAD"]);
  git(["cat-file", "-e", `${pin}^{commit}`]);
} catch {
  console.error(`error: pinned commit ${pin} not found in ${dshDir} (fetch upstream history first)`);
  process.exit(2);
}

const packages = [...new Set(manifest.areas.flatMap((a) => a.dshPackages))];
let failed = false;
for (const pkg of packages) {
  if (!existsSync(join(dshDir, pkg))) {
    console.error(`MISSING upstream package: ${pkg} (mapped in dsh-compat.json)`);
    failed = true;
  }
}

if (pin === head) {
  console.log(`pinned at upstream HEAD ${head.slice(0, 12)} (${manifest.dsh.version}) — no drift.`);
} else {
  failed = true;
  console.log(`drift: pinned ${pin.slice(0, 12)}, upstream HEAD ${head.slice(0, 12)}`);
  for (const area of manifest.areas) {
    const log = git(["log", "--oneline", `${pin}..HEAD`, "--", ...area.dshPackages]);
    const commits = log ? log.split("\n") : [];
    if (commits.length > 0) {
      console.log(`\n${area.area} [${area.status}] — ${commits.length} upstream commit(s) to review:`);
      for (const line of commits.slice(0, 30)) console.log(`  ${line}`);
      if (commits.length > 30) console.log(`  … +${commits.length - 30} more`);
    }
  }
  console.log("\nReview the commits above, port what applies, then re-run with --update-pin.");
}

if (updatePin) {
  let version = manifest.dsh.version;
  try { version = JSON.parse(readFileSync(join(dshDir, "package.json"), "utf8")).version ?? version; } catch { /* keep */ }
  let tag = manifest.dsh.tag;
  try { tag = git(["describe", "--tags", "--exact-match", "HEAD"]); } catch { /* untagged HEAD keeps prior tag */ }
  manifest.dsh.commit = head;
  manifest.dsh.version = version;
  manifest.dsh.tag = tag;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`pin updated to ${head.slice(0, 12)} (${version}). Commit dsh-compat.json with your parity review.`);
  process.exit(failed && pin !== head ? 0 : failed ? 1 : 0);
}
process.exit(failed ? 1 : 0);
