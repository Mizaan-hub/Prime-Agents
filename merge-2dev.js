#!/usr/bin/env node

// Must wrap script in async function to use await
(async () => {

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DEV_BRANCH = "dev-aymaan";
const DEPLOY_BRANCH = "merger";

const ALLOWED_ORG_DOMAIN = "https://orgfarm-50cf24d82e.lightning.force.com/";
const TARGET_ORG_ALIAS = "TDX";

// 🔥 Toggle auto commit ON/OFF
const autoCommit = true;   // if true → skip asking for commit msg

const DIFF_FILE = "deploy-file-list.txt";

/**
 * run - executes shell command and returns stdout+stderr as string.
 * If allowError is false, non-zero exit code will cause process.exit(1).
 * If allowError is true, returns whatever output (stdout+stderr) was produced.
 */
function run(cmd, allowError = false) {
  try {
    const out = execSync(cmd, { stdio: "pipe" });
    return out.toString().trim();
  } catch (e) {
    // Combine stdout and stderr (if available) so we can show the real CLI output
    const stdout = e.stdout ? e.stdout.toString() : "";
    const stderr = e.stderr ? e.stderr.toString() : "";
    const combined = (stdout + "\n" + stderr).trim();

    if (allowError) {
      // Return whatever output we captured
      return combined;
    }

    // Non-allowError: print and exit
    console.error(`❌ ERROR executing: ${cmd}\n${combined}`);
    if (cmd.includes(`git merge --no-edit ${DEV_BRANCH}`)) {
      console.log(`
        🚨 Manual action required!
        You now have merge conflicts in branch '${DEPLOY_BRANCH}'.

        Please do the following:
          Fix conflicts in your editor
          and then run:
            git add .
            git commit --no-edit
            git push origin ${DEPLOY_BRANCH}
            git checkout ${DEV_BRANCH}
          Re-run this script to continue deployment

        The script will stop now.
      `);
    }
    process.exit(1);
  }
}

// ----------------------- PRECHECK -----------------------
console.log("🔍 Checking if inside a Git repo...");
run("git rev-parse --is-inside-work-tree");
const current = run("git rev-parse --abbrev-ref HEAD");
if (current !== DEV_BRANCH) {
  console.error(`❌ Must run on '${DEV_BRANCH}', current: '${current}'`);
  run(`git checkout ${DEV_BRANCH}`);
  console.log('🔀 Switched to dev branch. Please re-run the script.');
  process.exit(1);
}

// -------------------- COMMIT CHANGES --------------------
console.log("📝 Checking for local changes...");
const changes = run("git status --porcelain");

if (changes) {
  const dateMsg = new Date().toLocaleString("en-IN");
  let finalCommitMsg = `by ${DEV_BRANCH} on ${dateMsg}`;

  if (!autoCommit) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    await new Promise(resolve => {
      rl.question("💬 Enter commit message (Press Enter to skip): ", msg => {
        if (msg.trim()) {
          finalCommitMsg = `${msg} by ${DEV_BRANCH} on ${dateMsg}`;
        }
        rl.close();
        resolve();
      });
    });
  }

  console.log(`📝 Committing with message: "${finalCommitMsg}"`);
  run("git add .");
  run(`git commit -m "${finalCommitMsg}"`);
}

run(`git push origin ${DEV_BRANCH}`);

// ---------------- RUN DIFF BEFORE MERGE ------------------
run("git fetch --all");

const diffCmd = `git diff --name-status origin/${DEPLOY_BRANCH}...origin/${DEV_BRANCH}`;
let diffRaw = run(diffCmd, true);

console.log("📌 RAW changed files BEFORE FILTER:");
console.log(diffRaw || "⚠️ EMPTY diff");

const rawFiles = diffRaw
  .split("\n")
  .map(line => {
    const [status, file] = line.trim().split(/\s+/);
    return { status, file };
  })
  .filter(x => x.file);

// -------- IMPROVED METADATA FILTERING --------
function getDeploySource(filePath, status) {
  // 🚫 NEVER deploy deleted files
  if (status === "D") return null;

  if (!filePath.startsWith("force-app/") && !filePath.startsWith("main/")) {
    return null;
  }

  const parts = filePath.split("/");

  // ✅ LWC → deploy bundle
  if (parts.includes("lwc")) {
    const idx = parts.indexOf("lwc");
    return parts.slice(0, idx + 2).join("/");
  }

  // ✅ Aura → deploy bundle
  if (parts.includes("aura")) {
    const idx = parts.indexOf("aura");
    return parts.slice(0, idx + 2).join("/");
  }

  // ✅ Everything else → deploy exact file
  return filePath;
}

const deploySources = Array.from(
  new Set(
    rawFiles
      .map(({ status, file }) => getDeploySource(file, status))
      .filter(Boolean)
  )
);

console.log("🎯 Final deploy sources:");
deploySources.forEach(f => console.log(" •", f));

fs.writeFileSync(DIFF_FILE, deploySources.join("\n"));

// ------------------------- MERGE -------------------------
console.log(`🔀 Switching to ${DEPLOY_BRANCH}...`);
run(`git checkout ${DEPLOY_BRANCH}`);

console.log(`⬇️ Pulling latest ${DEPLOY_BRANCH}...`);
run(`git pull origin ${DEPLOY_BRANCH}`);

console.log(`🔀 Merging ${DEV_BRANCH} → ${DEPLOY_BRANCH}`);
try {
  // allowError = true so we can inspect output instead of script exiting on merge conflicts
  const mergeOutput = run(`git merge --no-edit ${DEV_BRANCH}`, true);
  // If merge command wrote conflict markers or non-empty stderr, detect it
  if (/CONFLICT|Automatic merge failed|error:/.test(mergeOutput)) {
    console.error("❌ Merge produced conflicts. Please resolve manually.");
    console.log(`
      🚨 Manual action required!
      You now have merge conflicts in branch '${DEPLOY_BRANCH}'.

      Please do the following:
        Fix conflicts in your editor
        git add .
        git commit -m "Manual merge commit after resolving conflicts from ${DEV_BRANCH}"
        git push origin ${DEPLOY_BRANCH}

        After resolving conflicts and committing, run:

        node deploy-resolved.js

    `);
    process.exit(1);
  }
} catch (e) {
  // fallback - any unexpected merge error is fatal
  console.error("❌ Merge failed:", e);
  process.exit(1);
}

run(`git push origin ${DEPLOY_BRANCH}`);

console.log(`🔁 Switching back to ${DEV_BRANCH}...`);
run(`git checkout ${DEV_BRANCH}`);

console.log(`⬇️ Pulling latest ${DEPLOY_BRANCH}...`);
run(`git pull origin ${DEPLOY_BRANCH}`);

// ----------------------- DEPLOY --------------------------
let deployFiles = fs.readFileSync(DIFF_FILE, "utf8")
  .split("\n")
  .filter(f => f);

if (deployFiles.length === 0) {
  console.log("⚠️ No metadata to deploy.");
  process.exit(0);
}

console.log("🚀 Deploying changed metadata...");

// Build deploy command
const deployCmd =
  `sf project deploy start -o ${TARGET_ORG_ALIAS} --json ` +
  deployFiles.map(f => `--source-dir ${f}`).join(" ");

// Run deploy and allow errors so we capture stderr as well
let deployResultRaw = run(deployCmd, true);
fs.writeFileSync("deploy-log.txt", deployResultRaw);

// Try parse JSON result if CLI returned JSON
let deployJson = null;
try {
  deployJson = deployResultRaw ? JSON.parse(deployResultRaw) : null;
} catch (e) {
  // keep deployJson null; we'll still print human-readable output below
  deployJson = null;
}

// If no JSON or non-zero status, treat as failure and print helpful info
const isFailure = !deployJson || deployJson.status !== 0;

if (isFailure) {
  console.error("\n❌ DEPLOY FAILED!");

  // --- RAW LOG SAVED ---
  fs.writeFileSync("deploy-log.txt", deployResultRaw || "");

  console.log("\n📄 Full raw output saved to deploy-log.txt");

  console.log("\n=== CLEAN ERROR SUMMARY ===\n");

  const failures =
    deployJson?.result?.details?.componentFailures ||
    deployJson?.result?.files?.filter(f => f.state === "Failed") ||
    [];

  if (failures.length === 0) {
    console.log("⚠️ No structured error details found.");
  } else {
    failures.forEach(f => {
      console.log(`FILE   : ${f.filePath || f.fileName || "unknown"}`);
      if (f.lineNumber) console.log(`LINE   : ${f.lineNumber}`);
      if (f.columnNumber) console.log(`COLUMN : ${f.columnNumber}`);
      console.log(`ERROR  : ${f.problem || f.error || "Unknown error"}`);
      console.log("");
    });
  }

  // --- Start rollback logic ---
  console.log("\n🔁 Rolling back merge commit on deploy branch...");

  const mergeHash = run(`git rev-parse origin/${DEPLOY_BRANCH}`, true)
    || run(`git log -1 --pretty=format:%H origin/${DEPLOY_BRANCH}`, true);

  run(`git checkout ${DEPLOY_BRANCH}`);
  run(`git revert -m 1 ${mergeHash} --no-edit`, true);
  run(`git push origin ${DEPLOY_BRANCH}`, true);

  console.log("\n🧹 Merge reverted on deploy branch.");

  console.log("\n🗂️ Removing last commit from dev branch (remote), keeping local changes...");

  run(`git checkout ${DEV_BRANCH}`);
  run(`git reset --soft HEAD~1`, true);
  run(`git push origin +HEAD:${DEV_BRANCH}`, true);

  console.log("✅ Dev branch cleaned. Fix your code and re-run the script.");

  process.exit(1);
}

// ---------------- DEPLOY SUCCESS OUTPUT ------------------
let successFiles = [];

// Prefer files[] (most accurate)
if (Array.isArray(deployJson?.result?.details?.componentSuccesses)) {
    successFiles = deployJson.result.files
    .filter(f => ["Changed", "Created"].includes(f.state))
    .map(f => ({
      name: f.fullName,
      type: f.type,
      status: f.state,
      path: f.filePath
    }));
}
// Fallback to  componentSuccesses if files[] are missing
else if (Array.isArray(deployJson?.result?.files)) {
    successFiles = deployJson.result.details.componentSuccesses.map(c => ({
    name: c.fullName,
    type: c.componentType || "Unknown",
    status: "Deployed",
    path: c.fileName || "N/A"
  }));
}

console.log("🎉 DEPLOY SUCCESS!\n");

if (successFiles.length === 0) {
  console.log("⚠️ Deployment succeeded, but no component details were returned.");
} else {
  console.log("=== DEPLOYED COMPONENTS ===\n");

  successFiles.forEach(f => {
    console.log(`NAME   : ${f.name}`);
    console.log(`TYPE   : ${f.type}`);
    console.log(`STATUS : ${f.status}`);
    console.log(`PATH   : ${f.path}`);
    console.log("--------------------------------------");
  });
}

console.log("\n🎉 DONE!");

})();  // end async wrapper
