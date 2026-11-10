import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type BranchFacts, branchState } from "../../src/domain/worktree/branch-state.ts";

const facts = (overrides: Partial<BranchFacts> = {}): BranchFacts => ({
  branch: "feature/x",
  upstream: "refs/remotes/origin/feature/x",
  upstreamTrack: "",
  hasOriginMain: true,
  hasLocalMain: true,
  branchMergedIntoBase: false,
  mergeBase: "abc123",
  branchFiles: [],
  baseDifferingFiles: [],
  ...overrides,
});

describe("branchState", () => {
  test("a detached worktree has no branch to judge", () => {
    assert.equal(branchState(facts({ branch: null })), "detached");
  });

  test("a branch that was never pushed is open, even if it looks merged", () => {
    // A brand-new branch with no commit of its own is an ancestor of main, so without
    // this rule it would be reported merged and pruned while its peer is about to work.
    assert.equal(branchState(facts({ upstream: null, branchMergedIntoBase: true })), "open");
    assert.equal(branchState(facts({ upstream: "", branchMergedIntoBase: true })), "open");
  });

  test("tracking main is not a push of the branch", () => {
    assert.equal(branchState(facts({ upstream: "refs/remotes/origin/main", branchMergedIntoBase: true })), "open");
    assert.equal(branchState(facts({ upstream: "refs/heads/main", branchMergedIntoBase: true })), "open");
  });

  test("with no main to compare against, nothing is merged or gone", () => {
    assert.equal(branchState(facts({ hasOriginMain: false, hasLocalMain: false, branchMergedIntoBase: true })), "open");
  });

  test("an ancestor of main is merged", () => {
    assert.equal(branchState(facts({ branchMergedIntoBase: true })), "merged");
  });

  test("a squash merge is merged when base agrees on every file the branch touched", () => {
    // No ancestry left behind, so the content decides: the branch touched two files and
    // neither differs from base any more.
    assert.equal(branchState(facts({ branchFiles: ["src/a.ts", "src/b.ts"], baseDifferingFiles: [] })), "merged");
  });

  test("one file still differing means it is not merged", () => {
    assert.equal(
      branchState(facts({ branchFiles: ["src/a.ts", "src/b.ts"], baseDifferingFiles: ["src/b.ts"] })),
      "open",
    );
  });

  test("a branch that touched nothing is not merged by silence", () => {
    assert.equal(branchState(facts({ branchFiles: [], baseDifferingFiles: [] })), "open");
  });

  test("a pushed branch whose upstream is gone is gone", () => {
    assert.equal(branchState(facts({ branchFiles: ["src/a.ts"], baseDifferingFiles: ["src/a.ts"], upstreamTrack: "[gone]" })), "gone");
  });

  test("gone only applies once merged has been ruled out", () => {
    assert.equal(branchState(facts({ branchMergedIntoBase: true, upstreamTrack: "[gone]" })), "merged");
  });

  test("pushed, unmerged, upstream alive: open", () => {
    assert.equal(branchState(facts({ branchFiles: ["src/a.ts"], baseDifferingFiles: ["src/a.ts"] })), "open");
  });

  test("no shared history does not throw and does not claim merged", () => {
    assert.equal(branchState(facts({ mergeBase: null })), "open");
  });
});
