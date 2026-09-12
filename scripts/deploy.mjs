import { execFileSync } from "node:child_process";

const git = process.platform === "win32" ? "git.exe" : "git";
const wrangler = "npx";
const commit = execFileSync(git, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("GIT_COMMIT_SHA_UNAVAILABLE");

const args = ["wrangler", "deploy", "--var", `GIT_COMMIT_SHA:${commit}`];
if (process.argv.includes("--dry-run")) args.push("--dry-run");
execFileSync(wrangler, args, { shell: process.platform === "win32", stdio: "inherit" });
