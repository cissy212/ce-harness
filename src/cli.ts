#!/usr/bin/env node
import { isSupportedNodeVersion, unsupportedNodeVersionMessage } from "./core/nodeVersion.js";

const nodeVersion = process.versions.node;

if (!isSupportedNodeVersion(nodeVersion)) {
  console.error(unsupportedNodeVersionMessage(nodeVersion));
  process.exit(1);
}

// Deferred until the version check above passes: commander, execa, and
// their transitive dependencies are not even loaded on an unsupported
// Node version, so their syntax is never parsed and never throws a raw
// SyntaxError in place of the message above.
const { runCli } = await import("./cliMain.js");
await runCli();
