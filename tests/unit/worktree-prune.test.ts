import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type PruneCandidate, type PruneRequest, planPrune, renderPruneReport } from "../../src/domain/worktree/prune.ts";

const candidate = (overrides: Partial<PruneCandidate> = {}): PruneCandidate => ({
  path: "/repo/.claude/worktrees/topic",
  klass: "merged",
  kind: "topic",
  owner: "engineer",
  branch: "feature/x",
  dirty: 0,
  unpushed: 0,
  inUse: null,
  sizeKb: 1_000,
  missing: false,
  ...overrides,
});

const request = (overrides: Partial<PruneRequest> = {}): PruneRequest => ({
  idle: false,
  nested: false,
  cwd: "/somewhere/else",
  processes: [],
  ...overrides,
});

describe("planPrune decisions", () => {
  test("a clean merged worktree goes", () => {
    const plan = planPrune([candidate()], request());
    assert.deepEqual(plan.decisions, [{ action: "remove" }]);
    assert.equal(plan.removed, 1);
    assert.equal(plan.freedKb, 1_000);
  });

  test("a missing folder is pruned rather than removed", () => {
    const plan = planPrune([candidate({ missing: true })], request());
    assert.deepEqual(plan.decisions, [{ action: "prune-missing" }]);
    assert.equal(plan.freedKb, 0);
  });

  test("a dirty worktree stays, and says how dirty", () => {
    const plan = planPrune([candidate({ dirty: 2 })], request());
    assert.deepEqual(plan.decisions, [{ action: "keep", why: "dirty: 2 files" }]);
    assert.equal(plan.kept, 1);
  });

  test("unpushed commits are checked after dirt", () => {
    assert.deepEqual(planPrune([candidate({ unpushed: 3, inUse: "engineer" })], request()).decisions, [
      { action: "keep", why: "3 unpushed commits" },
    ]);
  });

  test("a peer sitting in it keeps it", () => {
    assert.deepEqual(planPrune([candidate({ inUse: "engineer" })], request()).decisions, [
      { action: "keep", why: "engineer is in it" },
    ]);
  });

  test("the caller's own directory keeps it, from inside or at the root", () => {
    const path = "/repo/.claude/worktrees/topic";
    assert.deepEqual(planPrune([candidate({ path })], request({ cwd: path })).decisions, [
      { action: "keep", why: "it is your current directory" },
    ]);
    assert.deepEqual(planPrune([candidate({ path })], request({ cwd: `${path}/src` })).decisions, [
      { action: "keep", why: "it is your current directory" },
    ]);
  });

  test("any process of the user in it keeps it, whichever shell started it", () => {
    const path = "/repo/.claude/worktrees/topic";
    assert.deepEqual(planPrune([candidate({ path })], request({ processes: [{ pid: "4242", cwd: `${path}/nested` }] })).decisions, [
      { action: "keep", why: "process 4242 is in it" },
    ]);
  });

  test("idle and nested are candidates only when asked for", () => {
    assert.deepEqual(planPrune([candidate({ klass: "idle" })], request()).decisions, [{ action: "skip" }]);
    assert.deepEqual(planPrune([candidate({ klass: "idle" })], request({ idle: true })).decisions, [{ action: "remove" }]);
    assert.deepEqual(planPrune([candidate({ klass: "nested" })], request()).decisions, [{ action: "skip" }]);
    assert.deepEqual(planPrune([candidate({ klass: "nested" })], request({ nested: true })).decisions, [{ action: "remove" }]);
  });

  test("active worktrees are never candidates", () => {
    const plan = planPrune([candidate({ klass: "active" })], request({ idle: true, nested: true }));
    assert.deepEqual(plan.decisions, [{ action: "skip" }]);
    assert.equal(plan.removed, 0);
    assert.equal(plan.kept, 0);
  });
});

describe("planPrune nesting", () => {
  const outer = candidate({ path: "/repo/.claude/worktrees/outer", sizeKb: 1_000 });
  const inner = candidate({ path: "/repo/.claude/worktrees/outer/.claude/worktrees/inner", sizeKb: 400 });

  test("a host is kept when the worktree inside it is kept", () => {
    const dirtyInner = candidate({ path: inner.path, dirty: 1 });
    const plan = planPrune([outer, dirtyInner], request());
    assert.deepEqual(plan.decisions[0], { action: "keep", why: `contains kept worktree ${dirtyInner.path}` });
    assert.deepEqual(plan.decisions[1], { action: "keep", why: "dirty: 1 files" });
  });

  test("two removable worktrees both go, host included", () => {
    const plan = planPrune([outer, inner], request({ nested: true }));
    assert.deepEqual(plan.decisions, [{ action: "remove" }, { action: "remove" }]);
  });

  test("the reason says when the nested one was only skipped by a flag", () => {
    const nestedInner = candidate({ path: inner.path, klass: "nested" });
    const plan = planPrune([outer, nestedInner], request({ nested: false }));
    assert.deepEqual(plan.decisions[0], {
      action: "keep",
      why: `contains kept worktree ${inner.path} (nested; skipped without --nested)`,
    });
  });

  test("a nested worktree's size is not counted twice", () => {
    const plan = planPrune([outer, inner], request({ nested: true }));
    assert.deepEqual(plan.decisions, [{ action: "remove" }, { action: "remove" }]);
    assert.deepEqual(plan.ownSizeKb, [600, 400]);
    assert.equal(plan.freedKb, 1_000);
  });

  test("depth orders the removals, so the inner one goes first", () => {
    const plan = planPrune([outer, inner], request({ nested: true }));
    assert.deepEqual(plan.order, [1, 0]);
  });

  test("a grandchild is not subtracted twice", () => {
    const grandchild = candidate({ path: `${inner.path}/.claude/worktrees/grand`, sizeKb: 100 });
    const plan = planPrune([outer, inner, grandchild], request({ nested: true }));
    // outer 1000 - inner 400 = 600; inner 400 - grand 100 = 300; grand 100.
    assert.deepEqual(plan.ownSizeKb, [600, 300, 100]);
    assert.equal(plan.freedKb, 1_000);
  });

  test("a size never goes negative", () => {
    const plan = planPrune([candidate({ path: "/a", sizeKb: 10 }), candidate({ path: "/a/b", sizeKb: 900 })], request({ nested: true }));
    assert.equal(plan.ownSizeKb[0], 0);
  });
});

describe("renderPruneReport", () => {
  test("a dry run says what would happen, in the script's words", () => {
    const plan = planPrune([candidate({ sizeKb: 4_302_899 })], request());
    assert.deepEqual(renderPruneReport([candidate({ sizeKb: 4_302_899 })], plan, { applied: false }), [
      "would remove /repo/.claude/worktrees/topic (merged, engineer, branch feature/x, 4.1G)",
      "would free 4.1G (1 worktrees)",
    ]);
  });

  test("a real run reports the same work with the other tense", () => {
    const rows = [candidate({ sizeKb: 1_024 })];
    assert.deepEqual(renderPruneReport(rows, planPrune(rows, request()), { applied: true }), [
      "removed /repo/.claude/worktrees/topic (merged, engineer, branch feature/x, 1M)",
      "freed 1M (1 worktrees)",
    ]);
  });

  test("keeps are printed with their class and reason, and counted", () => {
    const rows = [candidate({ dirty: 1 })];
    assert.deepEqual(renderPruneReport(rows, planPrune(rows, request()), { applied: false }), [
      "keep /repo/.claude/worktrees/topic (merged; dirty: 1 files)",
      "would free 0K (0 worktrees), kept 1",
    ]);
  });

  test("a detached ownerless worktree prints without empty commas", () => {
    const rows = [candidate({ owner: "-", branch: null, sizeKb: 10 })];
    assert.equal(renderPruneReport(rows, planPrune(rows, request()), { applied: false })[0], "would remove /repo/.claude/worktrees/topic (merged, 10K)");
  });

  test("a missing folder reports the git prune", () => {
    const rows = [candidate({ missing: true })];
    assert.deepEqual(renderPruneReport(rows, planPrune(rows, request()), { applied: false }), [
      "would prune /repo/.claude/worktrees/topic (folder missing; git worktree prune)",
      "would free 0K (0 worktrees)",
    ]);
  });

  test("the deepest worktree is listed first", () => {
    const outer = candidate({ path: "/r/a" });
    const inner = candidate({ path: "/r/a/b" });
    const rows = [outer, inner];
    assert.deepEqual(renderPruneReport(rows, planPrune(rows, request({ nested: true })), { applied: false }), [
      "would remove /r/a/b (merged, engineer, branch feature/x, 1000K)",
      "would remove /r/a (merged, engineer, branch feature/x, 0K)",
      "would free 1000K (2 worktrees)",
    ]);
  });
});
