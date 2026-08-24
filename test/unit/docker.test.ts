import { afterEach, describe, expect, it } from "vitest";
import {
  dockerBinary,
  findContainersMountingPath,
  findRunningContainersMountingPath,
} from "../../src/core/docker.js";
import {
  setupFakeDocker,
  setupFakeDockerNotInstalled,
  setupFakeDockerUnavailable,
  teardownFakeDocker,
} from "../helpers/fakeDocker.js";

describe("dockerBinary", () => {
  afterEach(() => {
    delete process.env.CE_DOCKER_BIN;
  });

  it('defaults to "docker"', () => {
    delete process.env.CE_DOCKER_BIN;
    expect(dockerBinary()).toBe("docker");
  });

  it("CE_DOCKER_BIN overrides the resolved binary", () => {
    process.env.CE_DOCKER_BIN = "/custom/path/to/docker";
    expect(dockerBinary()).toBe("/custom/path/to/docker");
  });
});

describe("findContainersMountingPath (pure matching, no Docker involved)", () => {
  it("matches a bind mount whose source is exactly the target path", () => {
    const containers = [
      { name: "app", mounts: [{ source: "/tmp/worktree", type: "bind" }] },
    ];
    expect(findContainersMountingPath(containers, "/tmp/worktree")).toEqual([
      { name: "app", source: "/tmp/worktree" },
    ]);
  });

  it("matches a bind mount whose source is a descendant of the target path", () => {
    const containers = [
      { name: "app", mounts: [{ source: "/tmp/worktree/packages/frontend", type: "bind" }] },
    ];
    expect(findContainersMountingPath(containers, "/tmp/worktree")).toEqual([
      { name: "app", source: "/tmp/worktree/packages/frontend" },
    ]);
  });

  it('never matches a sibling path that merely shares a string prefix (e.g. "/foo/bar" vs "/foo/bar2")', () => {
    const containers = [{ name: "app", mounts: [{ source: "/foo/bar2", type: "bind" }] }];
    expect(findContainersMountingPath(containers, "/foo/bar")).toEqual([]);
  });

  it("never matches a mount above the target path (a parent is not \"inside\" its child)", () => {
    const containers = [{ name: "app", mounts: [{ source: "/foo", type: "bind" }] }];
    expect(findContainersMountingPath(containers, "/foo/bar")).toEqual([]);
  });

  it('never matches a "volume" mount even if its source string looks similar', () => {
    const containers = [
      { name: "app", mounts: [{ source: "/tmp/worktree/node_modules", type: "volume" }] },
    ];
    expect(findContainersMountingPath(containers, "/tmp/worktree")).toEqual([]);
  });

  it("strips Docker Desktop's /host_mnt prefix before comparing", () => {
    const containers = [
      { name: "app", mounts: [{ source: "/host_mnt/tmp/worktree/src", type: "bind" }] },
    ];
    expect(findContainersMountingPath(containers, "/tmp/worktree")).toEqual([
      { name: "app", source: "/host_mnt/tmp/worktree/src" },
    ]);
  });

  it("returns every match across multiple containers/mounts, never just the first", () => {
    const containers = [
      { name: "frontend", mounts: [{ source: "/tmp/worktree/frontend", type: "bind" }] },
      { name: "server", mounts: [{ source: "/tmp/worktree/server/src", type: "bind" }, { source: "/tmp/worktree/server/test", type: "bind" }] },
      { name: "unrelated", mounts: [{ source: "/tmp/other-worktree", type: "bind" }] },
    ];
    const result = findContainersMountingPath(containers, "/tmp/worktree");
    expect(result.map((r) => r.name).sort()).toEqual(["frontend", "server", "server"].sort());
    expect(result).not.toContainEqual(expect.objectContaining({ name: "unrelated" }));
  });

  it("returns [] when nothing matches", () => {
    const containers = [{ name: "app", mounts: [{ source: "/completely/unrelated", type: "bind" }] }];
    expect(findContainersMountingPath(containers, "/tmp/worktree")).toEqual([]);
  });

  it("returns [] for an empty container list", () => {
    expect(findContainersMountingPath([], "/tmp/worktree")).toEqual([]);
  });
});

describe("findRunningContainersMountingPath (via the fake docker CLI)", () => {
  afterEach(() => {
    teardownFakeDocker();
  });

  it("finds a running container bind-mounted inside the target path", async () => {
    setupFakeDocker([
      {
        id: "abc123",
        name: "scv-ai-frontend",
        mounts: [{ source: "/tmp/demo-worktree/packages/scv-ai/frontend", type: "bind" }],
      },
    ]);

    const blockers = await findRunningContainersMountingPath("/tmp/demo-worktree");
    // Both sides are canonicalized before comparison (e.g. macOS resolves
    // "/tmp" to "/private/tmp"), and the reported source reflects that
    // same canonical form -- proven directly rather than asserting a
    // literal, platform-dependent string.
    expect(blockers).toHaveLength(1);
    expect(blockers[0].name).toBe("scv-ai-frontend");
    expect(blockers[0].source.endsWith("/demo-worktree/packages/scv-ai/frontend")).toBe(true);
  });

  it("returns [] when no running container mounts anything inside the target path", async () => {
    setupFakeDocker([
      { id: "abc123", name: "unrelated", mounts: [{ source: "/tmp/somewhere-else", type: "bind" }] },
    ]);

    expect(await findRunningContainersMountingPath("/tmp/demo-worktree")).toEqual([]);
  });

  it("returns [] when there are no running containers at all", async () => {
    setupFakeDocker([]);
    expect(await findRunningContainersMountingPath("/tmp/demo-worktree")).toEqual([]);
  });

  it("returns [] (never throws) when Docker is not installed", async () => {
    setupFakeDockerNotInstalled();
    await expect(findRunningContainersMountingPath("/tmp/demo-worktree")).resolves.toEqual([]);
  });

  it("returns [] (never throws) when the Docker daemon is unreachable", async () => {
    setupFakeDockerUnavailable();
    await expect(findRunningContainersMountingPath("/tmp/demo-worktree")).resolves.toEqual([]);
  });
});
