#!/usr/bin/env node
// A minimal stand-in for the `gh` (GitHub CLI) executable, used
// exclusively by tests so they never invoke the real executable, hit
// GitHub, or require network access / real authentication.
//
// The PR data `gh pr view --json ...` should return is supplied per-test
// via the FAKE_GH_PR_JSON environment variable (a JSON string matching
// the shape resolvePrSnapshot() expects). Failure modes are toggled via
// environment variables:
//   FAKE_GH_FAIL_AUTH=1        - `gh auth status` always fails (not logged in)
//   FAKE_GH_FAIL_RESOLVE=1     - `gh pr view` always fails (PR not found)
//   FAKE_GH_EXISTING_PR_URL    - `gh pr list --head <branch>` returns this
//                                 one open PR (unset/empty: none open)
//   FAKE_GH_FAIL_CREATE=1      - `gh pr create` always fails
//   FAKE_GH_CREATE_PR_URL      - the URL `gh pr create` reports on success
//                                 (default: a synthetic github.com URL)
//   FAKE_GH_RECORD_FILE        - if set, `gh pr create`'s parsed
//                                 arguments (repo/base/head/title/body)
//                                 are written here as JSON, for tests to
//                                 assert exactly what was passed

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("fake-gh version 0.0.0-test");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if (process.env.FAKE_GH_FAIL_AUTH === "1") {
    console.error("You are not logged into any GitHub hosts. Run gh auth login to authenticate.");
    process.exit(1);
  }
  console.log("Logged in to github.com as fake-test-user");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  if (process.env.FAKE_GH_FAIL_RESOLVE === "1") {
    console.error("GraphQL: Could not resolve to a PullRequest with the number of " + args[2] + ".");
    process.exit(1);
  }

  const raw = process.env.FAKE_GH_PR_JSON;
  if (!raw) {
    console.error("fake-gh: FAKE_GH_PR_JSON is not set");
    process.exit(2);
  }
  process.stdout.write(raw);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  const url = process.env.FAKE_GH_EXISTING_PR_URL;
  process.stdout.write(JSON.stringify(url ? [{ url }] : []));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "create") {
  if (process.env.FAKE_GH_FAIL_CREATE === "1") {
    console.error("fake-gh: pr create failed (FAKE_GH_FAIL_CREATE=1)");
    process.exit(1);
  }

  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const bodyFile = flag("--body-file");
  const record = {
    repo: flag("--repo"),
    base: flag("--base"),
    head: flag("--head"),
    title: flag("--title"),
    body: bodyFile ? readFileSync(bodyFile, "utf8") : undefined,
  };
  if (process.env.FAKE_GH_RECORD_FILE) {
    writeFileSync(process.env.FAKE_GH_RECORD_FILE, JSON.stringify(record, null, 2), "utf8");
  }

  const url = process.env.FAKE_GH_CREATE_PR_URL || "https://github.com/example/example/pull/999";
  process.stdout.write(`${url}\n`);
  process.exit(0);
}

console.error(`fake-gh: unsupported command ${JSON.stringify(args)}`);
process.exit(2);
