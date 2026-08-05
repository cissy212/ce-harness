import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isSupportedNodeVersion,
  MINIMUM_SUPPORTED_NODE_VERSION,
  unsupportedNodeVersionMessage,
} from "../../src/core/nodeVersion.js";

describe("isSupportedNodeVersion", () => {
  it("rejects versions below the minimum major", () => {
    expect(isSupportedNodeVersion("18.13.0")).toBe(false);
    expect(isSupportedNodeVersion("20.11.0")).toBe(false);
    expect(isSupportedNodeVersion("21.0.0")).toBe(false);
  });

  it("rejects the minimum major with too low a minor", () => {
    expect(isSupportedNodeVersion("22.0.0")).toBe(false);
    expect(isSupportedNodeVersion("22.11.9")).toBe(false);
  });

  it("accepts exactly the minimum version", () => {
    expect(isSupportedNodeVersion("22.12.0")).toBe(true);
  });

  it("accepts a higher minor on the minimum major", () => {
    expect(isSupportedNodeVersion("22.13.0")).toBe(true);
    expect(isSupportedNodeVersion("22.99.5")).toBe(true);
  });

  it("accepts any later major version regardless of minor", () => {
    expect(isSupportedNodeVersion("23.0.0")).toBe(true);
    expect(isSupportedNodeVersion("24.0.0")).toBe(true);
    expect(isSupportedNodeVersion("30.0.0")).toBe(true);
  });

  it("rejects unparseable input rather than throwing", () => {
    expect(isSupportedNodeVersion("")).toBe(false);
    expect(isSupportedNodeVersion("not-a-version")).toBe(false);
  });
});

describe("unsupportedNodeVersionMessage", () => {
  it("names both the requirement and the actual running version", () => {
    const message = unsupportedNodeVersionMessage("18.13.0");

    expect(message).toContain(`>=${MINIMUM_SUPPORTED_NODE_VERSION}`);
    expect(message).toContain("18.13.0");
  });

  it("is actionable: it names a concrete upgrade path, not just the failure", () => {
    const message = unsupportedNodeVersionMessage("18.13.0");

    expect(message).toMatch(/nvm install/);
    expect(message).toMatch(/nodejs\.org/);
  });

  it("contains no stack trace or dependency-internal detail", () => {
    const message = unsupportedNodeVersionMessage("18.13.0");

    expect(message).not.toMatch(/at .*\(.*:\d+:\d+\)/); // a stack-trace frame
    expect(message).not.toMatch(/node_modules/);
  });
});

describe("minimum Node version stays consistent across package.json, the runtime guard, and README.md", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

  it("package.json's engines.node matches the runtime guard", async () => {
    const pkg = JSON.parse(await readFile(`${repoRoot}/package.json`, "utf8"));
    expect(pkg.engines?.node).toBe(`>=${MINIMUM_SUPPORTED_NODE_VERSION}`);
  });

  it("README.md documents the same minimum version", async () => {
    const readme = await readFile(`${repoRoot}/README.md`, "utf8");
    expect(readme).toContain(MINIMUM_SUPPORTED_NODE_VERSION);
  });
});
