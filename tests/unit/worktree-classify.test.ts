import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type ScanContext, type WorktreeRow, classifyWorktree, isInside } from "../../src/domain/worktree/classify.ts";

const NOW = 1_700_000_000;
const DAY = 86_400;

const row = (overrides: Partial<WorktreeRow> = {}): WorktreeRow => ({
  profile: "a",
  repo: "/repo",
  path: "/repo/.claude/worktrees/topic",
  owner: "engineer",
  kind: "topic",
  branch: "feature/x",
  pr: "-",
  lastChange: NOW - 60,
  dirty: 0,
  unpushed: 0,
  sizeKb: 100,
  inUse: null,
  branchState: "open",
  missing: false,
  ...overrides,
});

const context = (overrides: Partial<ScanContext> = {}): ScanContext => ({
  runningPeers: ["engineer"],
  allPaths: ["/repo/.claude/worktrees/topic"],
  idleDays: 7,
  now: NOW,
  ...overrides,
});

describe("isInside", () => {
  test("a child is below its parent", () => {
    assert.equal(isInside("/a", "/a/b"), true);
    assert.equal(isInside("/a", "/a"), false);
  });

  test("a sibling sharing a prefix is not below it", () => {
    assert.equal(isInside("/a/b", "/a/bc"), false);
  });

  test("a trailing slash changes nothing", () => {
    assert.equal(isInside("/a/", "/a/b"), true);
  });
});

describe("classifyWorktree", () => {
  test("a folder that is gone is orphaned whatever it holds", () => {
    assert.equal(classifyWorktree(row({ missing: true, branchState: "merged" }), context()), "orphaned");
  });

  test("a launch worktree outlives its peer only while the peer runs", () => {
    assert.equal(classifyWorktree(row({ kind: "launch" }), context()), "active");
    assert.equal(classifyWorktree(row({ kind: "launch" }), context({ runningPeers: ["designer"] })), "orphaned");
    assert.equal(classifyWorktree(row({ kind: "launch", owner: null }), context()), "orphaned");
  });

  test("a topic whose owner is not running is orphaned, but only while the fleet runs", () => {
    const absent = context({ runningPeers: ["designer"] });
    assert.equal(classifyWorktree(row(), absent), "orphaned");
    // With every peer down the owner always looks absent, so the rule must not fire.
    assert.equal(classifyWorktree(row(), context({ runningPeers: [] })), "active");
    assert.equal(classifyWorktree(row({ owner: null }), absent), "active");
  });

  test("an opencode worktree lives only while something is in it", () => {
    assert.equal(classifyWorktree(row({ kind: "opencode", inUse: "engineer" }), context()), "active");
    assert.equal(classifyWorktree(row({ kind: "opencode" }), context()), "orphaned");
  });

  test("a worktree inside another one is nested", () => {
    const outer = "/repo/.claude/worktrees/topic";
    const inner = `${outer}/.claude/worktrees/deep`;
    assert.equal(classifyWorktree(row({ path: inner }), context({ allPaths: [outer, inner] })), "nested");
  });

  test("the branch state decides merged and gone", () => {
    assert.equal(classifyWorktree(row({ branchState: "merged" }), context()), "merged");
    assert.equal(classifyWorktree(row({ branchState: "gone" }), context()), "gone");
  });

  test("a squash-merged PR is merged even when the branch looks open", () => {
    assert.equal(classifyWorktree(row({ pr: "#12 merged" }), context()), "merged");
    assert.equal(classifyWorktree(row({ pr: "#12 closed" }), context()), "active");
    assert.equal(classifyWorktree(row({ pr: "none" }), context()), "active");
  });

  test("a topic with no change for the idle days is idle", () => {
    assert.equal(classifyWorktree(row({ lastChange: NOW - 7 * DAY }), context()), "idle");
    assert.equal(classifyWorktree(row({ lastChange: NOW - 6 * DAY }), context()), "active");
    assert.equal(classifyWorktree(row({ lastChange: NOW - 60 * DAY }), context({ idleDays: 30 })), "idle");
  });

  test("only topic worktrees go idle", () => {
    assert.equal(classifyWorktree(row({ kind: "launch", lastChange: NOW - 60 * DAY }), context()), "active");
  });

  test("a live branch that is not stale is active", () => {
    assert.equal(classifyWorktree(row({ branchState: "open" }), context()), "active");
    assert.equal(classifyWorktree(row({ branchState: "detached" }), context()), "active");
  });
});
