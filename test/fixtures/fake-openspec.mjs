#!/usr/bin/env node
// A minimal stand-in for the `openspec` CLI, used exclusively by tests so
// they never invoke the real executable or touch the user's real
// OpenSpec store registry.
//
// State is kept in a JSON file whose path is supplied per-test via the
// FAKE_OPENSPEC_REGISTRY environment variable, so tests never share
// registry state with each other or with the real ~/.local/share/openspec
// registry.
//
// Failure modes for integration tests are toggled via environment
// variables:
//   FAKE_OPENSPEC_FAIL_SETUP=1       - `store setup` always fails
//   FAKE_OPENSPEC_FAIL_DOCTOR=1      - `store doctor` reports unhealthy
//   FAKE_OPENSPEC_FAIL_UNREGISTER=1  - `store unregister` always fails
//     (for an id that IS registered; a genuinely unknown id still
//     reports store_not_found so idempotent-cleanup tests keep working)
//   FAKE_OPENSPEC_SILENT_CRASH=1     - any subcommand exits non-zero with
//     no stdout and no stderr at all (simulates a killed/crashed process)
//   FAKE_OPENSPEC_GARBAGE_STDOUT=1   - any subcommand exits non-zero with
//     non-JSON stdout and no stderr

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const registryPath = process.env.FAKE_OPENSPEC_REGISTRY;

function loadRegistry() {
  if (!registryPath || !existsSync(registryPath)) return {};
  try {
    return JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return {};
  }
}

function saveRegistry(registry) {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function notFoundStatus(id) {
  return [
    {
      severity: "error",
      code: "store_not_found",
      message: `Unknown store '${id}'.`,
      target: "store.id",
      fix: "Run openspec store list to see registered stores.",
    },
  ];
}

if (args[0] === "--version") {
  console.log("fake-openspec 0.0.0-test");
  process.exit(0);
}

if (args[0] !== "store") {
  console.error(`fake-openspec: unsupported command ${JSON.stringify(args)}`);
  process.exit(2);
}

const sub = args[1];

// Two more toggles, applied uniformly regardless of which subcommand runs
// (setup/doctor/unregister all go through the same result-parsing code in
// core/openspec.ts): simulate a child process that dies with *no*
// structured status and *no* stderr at all -- exactly the real, reported
// case that previously produced an unhelpful, information-free error
// message (see core/openspec.ts's `describeOpenSpecStatus`/`callOutcome`).
if (process.env.FAKE_OPENSPEC_SILENT_CRASH === "1") {
  // No stdout, no stderr -- e.g. a process killed by a signal before it
  // could report anything.
  process.exit(17);
}
if (process.env.FAKE_OPENSPEC_GARBAGE_STDOUT === "1") {
  // Non-empty stdout that is not the expected JSON status shape, and
  // still no stderr -- e.g. a stray warning line, or output from a
  // future CLI version whose shape ce-harness doesn't understand yet.
  process.stdout.write("unexpected: not a JSON status payload\n");
  process.exit(9);
}

if (sub === "setup") {
  const id = args[2];
  const pathFlagIndex = args.indexOf("--path");
  const storePath = pathFlagIndex >= 0 ? args[pathFlagIndex + 1] : undefined;

  if (process.env.FAKE_OPENSPEC_FAIL_SETUP === "1") {
    printJson({
      store: null,
      registry: null,
      git: null,
      created_files: [],
      status: [
        {
          severity: "error",
          code: "fake_setup_failure",
          message: "Simulated setup failure for testing.",
        },
      ],
    });
    process.exit(1);
  }

  const registry = loadRegistry();
  if (registry[id]) {
    printJson({
      store: null,
      registry: null,
      git: null,
      created_files: [],
      status: [
        {
          severity: "error",
          code: "store_id_conflict",
          message: `Store '${id}' is already registered at ${registry[id].root}.`,
          target: "store.id",
        },
      ],
    });
    process.exit(1);
  }

  mkdirSync(storePath, { recursive: true });
  registry[id] = { root: storePath };
  saveRegistry(registry);

  printJson({
    store: { id, root: storePath, metadata_path: `${storePath}/.openspec-store/store.yaml` },
    registry: { path: registryPath, registered: true, already_registered: false },
    git: { is_repository: false, initialized: false, committed: false },
    created_files: ["openspec/", "openspec/specs/", "openspec/changes/"],
    status: [],
  });
  process.exit(0);
}

if (sub === "doctor") {
  const id = args[2];
  const registry = loadRegistry();
  const entry = registry[id];

  if (!entry) {
    printJson({ stores: [], status: notFoundStatus(id) });
    process.exit(1);
  }

  const forceUnhealthy = process.env.FAKE_OPENSPEC_FAIL_DOCTOR === "1";
  printJson({
    stores: [
      {
        id,
        root: entry.root,
        metadata_path: `${entry.root}/.openspec-store/store.yaml`,
        openspec_root: {
          present: !forceUnhealthy,
          healthy: !forceUnhealthy,
          status: forceUnhealthy
            ? [
                {
                  severity: "error",
                  code: "fake_unhealthy",
                  message: "Simulated unhealthy store for testing.",
                },
              ]
            : [],
        },
        metadata: { present: true, valid: true, id, remote: null },
        git: {
          is_repository: false,
          has_commits: null,
          has_uncommitted_changes: null,
          has_remote: null,
          origin_url: null,
        },
        status: [],
      },
    ],
    status: [],
  });
  process.exit(0);
}

if (sub === "unregister") {
  const id = args[2];
  const registry = loadRegistry();
  const entry = registry[id];

  if (!entry) {
    printJson({ store: null, registry: null, files: null, status: notFoundStatus(id) });
    process.exit(1);
  }

  if (process.env.FAKE_OPENSPEC_FAIL_UNREGISTER === "1") {
    printJson({
      store: null,
      registry: null,
      files: null,
      status: [
        {
          severity: "error",
          code: "fake_unregister_failure",
          message: "Simulated unregister failure for testing.",
        },
      ],
    });
    process.exit(1);
  }

  const root = entry.root;
  delete registry[id];
  saveRegistry(registry);

  printJson({
    store: { id, root },
    registry: { path: registryPath, removed: true },
    files: { deleted: false, deleted_path: null, left_on_disk: root },
    status: [],
  });
  process.exit(0);
}

if (sub === "list" || sub === "ls") {
  const registry = loadRegistry();
  const stores = Object.entries(registry).map(([id, value]) => ({ id, root: value.root }));
  printJson({ stores, status: [] });
  process.exit(0);
}

console.error(`fake-openspec: unsupported store subcommand ${JSON.stringify(args)}`);
process.exit(2);
