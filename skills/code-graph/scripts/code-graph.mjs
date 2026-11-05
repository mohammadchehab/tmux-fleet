#!/usr/bin/env node
// Answers small questions from an Understand-Anything knowledge graph so an agent can find code
// without reading files to orient. Every answer is capped (--limit) to keep token use low.
// Usage: node code-graph.mjs <command> [args] [--limit N] [--depth N] [--graph PATH]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const HELP = `code-graph <command> [args]

  where <words...>     files, functions and classes matching the words (name, path, summary, tags)
  file <path|name>     one file: summary, what it defines, what it imports, who imports it
  impact <path|name>   who depends on it, by distance (imports, calls, depends_on); --depth N (default 2)
  deps <path|name>     what it depends on, by distance; --depth N (default 1)
  layers               the architectural layers with file counts
  layer <name>         one layer: description and its main files
  tours                the guided tours
  tour <n>             one tour step
  stats                graph size, when it was built, files changed since

Options: --limit N (default 15)  --graph PATH (a graph file or a project directory)
Finds .understand-anything/ or .ua/ from the current directory upwards, then in the main
checkout when run inside a git worktree. Results marked * changed after the graph was built.`;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const limit = Number(opt("limit", 15));
const depthArg = opt("depth", null);
const graphArg = opt("graph", process.env.CODE_GRAPH || null);
const [command, ...rest] = args;

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(HELP);
  process.exit(0);
}

const git = (cwd, ...a) => {
  try {
    return execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

function graphFileIn(dir) {
  for (const sub of [".understand-anything", ".ua"]) {
    const file = join(dir, sub, "knowledge-graph.json");
    if (existsSync(file)) return file;
  }
  return null;
}

function findGraph() {
  if (graphArg) {
    const p = resolve(graphArg);
    if (existsSync(p) && statSync(p).isFile()) return p;
    const inDir = graphFileIn(p);
    if (inDir) return inDir;
    fail(`No knowledge graph at ${graphArg}.`);
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const found = graphFileIn(dir);
    if (found) return found;
    if (dirname(dir) === dir) break;
  }
  const common = git(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common) {
    const found = graphFileIn(dirname(common));
    if (found) return found;
  }
  fail("No knowledge graph found. Run /understand in the project first (it writes .ua/knowledge-graph.json).");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const graphFile = findGraph();
const projectDir = dirname(dirname(graphFile));
const graph = JSON.parse(readFileSync(graphFile, "utf8"));
const nodes = graph.nodes || [];
const edges = graph.edges || [];
const byId = new Map(nodes.map((n) => [n.id, n]));
const meta = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(graphFile), "meta.json"), "utf8"));
  } catch {
    return {};
  }
})();

// Files changed since the graph was built: committed since its commit, plus uncommitted. Read from
// the checkout you are in, so a worktree sees its own branch's changes against the shared graph.
const changed = (() => {
  const set = new Set();
  const projectRepo = git(projectDir, "rev-parse", "--show-toplevel");
  const repo = git(process.cwd(), "rev-parse", "--show-toplevel") || projectRepo;
  if (!repo) return set;
  const lines = [
    meta.gitCommitHash ? git(repo, "diff", "--name-only", `${meta.gitCommitHash}..HEAD`) : "",
    git(repo, "diff", "--name-only", "HEAD"),
  ];
  const prefix = projectRepo ? relative(projectRepo, projectDir) : "";
  for (const line of lines.join("\n").split("\n")) {
    if (!line) continue;
    set.add(prefix ? relative(prefix, line) : line);
  }
  return set;
})();

const clip = (text, n = 140) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const lines = (n) => (Array.isArray(n.lineRange) ? `:${n.lineRange[0]}-${n.lineRange[1]}` : "");
const mark = (n) => (n.filePath && changed.has(n.filePath) ? "*" : "");
const label = (n) =>
  n.type === "file" || !n.filePath ? `${n.filePath || n.name}${mark(n)}` : `${n.name} (${n.filePath}${lines(n)})${mark(n)}`;
const row = (n) => `- ${label(n)} — ${clip(n.summary)}`;
const more = (total) => (total > limit ? `… ${total - limit} more (--limit ${total})` : null);
const print = (...out) => console.log(out.filter((x) => x != null && x !== "").join("\n"));

const fileOf = (n) => (n.type === "file" ? n : byId.get(`file:${n.filePath}`) || n);

function resolveTarget(query) {
  if (!query) fail("Give a file path or a name.");
  const q = query.replace(/^\.\//, "");
  const exact = byId.get(q) || byId.get(`file:${q}`) || nodes.find((n) => n.type === "file" && n.filePath === q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  const hits = nodes.filter(
    (n) => (n.filePath || "").toLowerCase().endsWith(`/${lower}`) || (n.name || "").toLowerCase() === lower,
  );
  hits.sort((a, b) => (a.type === "file" ? 0 : 1) - (b.type === "file" ? 0 : 1));
  if (hits.length === 0) fail(`Nothing named "${query}". Try: code-graph where ${query}`);
  if (hits.length > 1 && hits[0].type === hits[1].type && hits[1].type === "file") {
    print(`"${query}" matches several files; use a longer path:`, ...hits.slice(0, limit).map((n) => `- ${n.filePath}`));
    process.exit(1);
  }
  return hits[0];
}

const DEP = new Set(["imports", "calls", "depends_on", "implements", "configures", "triggers", "routes"]);

// Walks dependency edges from a node, file-level: a function's edges count for its file.
function walk(start, direction, maxDepth) {
  const startFile = fileOf(start);
  const ids = new Set([start.id, startFile.id]);
  for (const e of edges) if (e.type === "contains" && e.source === startFile.id) ids.add(e.target);
  const seen = new Set([startFile.id]);
  const levels = [];
  let frontier = ids;
  for (let d = 1; d <= maxDepth; d++) {
    const next = new Set();
    const found = new Map();
    for (const e of edges) {
      if (!DEP.has(e.type)) continue;
      const [from, to] = direction === "in" ? [e.target, e.source] : [e.source, e.target];
      if (!frontier.has(from)) continue;
      const other = byId.get(to);
      if (!other) continue;
      const f = fileOf(other);
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      found.set(f.id, f);
    }
    if (found.size === 0) break;
    levels.push([...found.values()]);
    for (const f of found.values()) {
      next.add(f.id);
      for (const e of edges) if (e.type === "contains" && e.source === f.id) next.add(e.target);
    }
    frontier = next;
  }
  return levels;
}

function where(words) {
  if (!words.length) fail("Give one or more words.");
  const terms = words.map((w) => w.toLowerCase());
  const scored = [];
  for (const n of nodes) {
    if (!["file", "function", "class", "service", "pipeline", "config", "table", "document"].includes(n.type)) continue;
    const name = (n.name || "").toLowerCase();
    const path = (n.filePath || "").toLowerCase();
    const summary = (n.summary || "").toLowerCase();
    const tags = (n.tags || []).join(" ").toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const s = (name.includes(t) ? 5 : 0) + (path.includes(t) ? 3 : 0) + (tags.includes(t) ? 2 : 0) + (summary.includes(t) ? 1 : 0);
      if (s > 0) matched++;
      score += s;
    }
    if (score === 0) continue;
    if (n.type === "file") score += 1;
    if (/(\.|\/)(test|spec)s?\b|__tests__/.test(path)) score -= 4;
    scored.push([matched, score, n]);
  }
  // More words matched ranks first, then the weighted score, so a long query still surfaces near misses.
  scored.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  if (!scored.length) return print(`No match for "${words.join(" ")}". Try other words.`);
  const shown = scored.slice(0, limit);
  const partial = shown.findIndex(([m]) => m < terms.length);
  const out = shown.map(([, , n], i) => (i === partial ? `Matching only some words:\n${row(n)}` : row(n)));
  print(...out, more(scored.length));
}

function file(query) {
  const n = fileOf(resolveTarget(query));
  const inside = edges.filter((e) => e.type === "contains" && e.source === n.id).map((e) => byId.get(e.target)).filter(Boolean);
  const imports = walk(n, "out", 1)[0] || [];
  const importedBy = walk(n, "in", 1)[0] || [];
  const layer = (graph.layers || []).find((l) => (l.nodeIds || []).includes(n.id));
  print(
    `${n.filePath || n.name}${mark(n)}${n.complexity ? ` [${n.complexity}]` : ""}${layer ? ` · layer: ${layer.name}` : ""}`,
    clip(n.summary, 400),
    n.languageNotes ? `Note: ${clip(n.languageNotes, 240)}` : null,
    inside.length ? `Defines (${inside.length}):` : null,
    ...inside.slice(0, limit).map((c) => `- ${c.name}${lines(c)} — ${clip(c.summary, 100)}`),
    inside.length ? more(inside.length) : null,
    `Depends on (${imports.length}): ${imports.slice(0, limit).map((f) => f.filePath).join(", ") || "none"}`,
    `Used by (${importedBy.length}): ${importedBy.slice(0, limit).map((f) => f.filePath).join(", ") || "none"}`,
  );
}

function trace(query, direction, defaultDepth) {
  const start = resolveTarget(query);
  const maxDepth = Number(depthArg || defaultDepth);
  const levels = walk(start, direction, maxDepth);
  const verb = direction === "in" ? "Used by" : "Depends on";
  if (!levels.length) return print(`${label(fileOf(start))}: nothing ${direction === "in" ? "depends on it" : "it depends on"} in the graph.`);
  const total = levels.reduce((s, l) => s + l.length, 0);
  let budget = limit;
  const out = [`${verb} ${label(fileOf(start))} — ${total} files within ${levels.length} step(s)`];
  levels.forEach((level, i) => {
    out.push(`Step ${i + 1} (${level.length}):`);
    for (const f of level.slice(0, Math.max(budget, 0))) out.push(row(f));
    if (level.length > budget) out.push(`  … ${level.length - Math.max(budget, 0)} more at this step`);
    budget -= level.length;
  });
  print(...out);
}

function layers() {
  const list = graph.layers || [];
  if (!list.length) return print("This graph has no layers.");
  print(...list.map((l) => `- ${l.name} (${(l.nodeIds || []).length} files) — ${clip(l.description, 120)}`));
}

function layer(query) {
  const q = (query || "").toLowerCase();
  const l = (graph.layers || []).find((x) => x.name.toLowerCase().includes(q) || (x.id || "").toLowerCase().includes(q));
  if (!q || !l) fail(`No layer matching "${query || ""}". Run: code-graph layers`);
  const members = (l.nodeIds || []).map((id) => byId.get(id)).filter(Boolean);
  const fanIn = new Map();
  const memberIds = new Set(members.map((m) => m.id));
  for (const e of edges) if (e.type === "imports" && memberIds.has(e.target)) fanIn.set(e.target, (fanIn.get(e.target) || 0) + 1);
  members.sort((a, b) => (fanIn.get(b.id) || 0) - (fanIn.get(a.id) || 0));
  print(`${l.name} — ${members.length} files`, clip(l.description, 400), "Most imported:", ...members.slice(0, limit).map(row), more(members.length));
}

function tours() {
  const list = graph.tour || graph.tours || [];
  if (!list.length) return print("This graph has no tours.");
  print(...list.map((t, i) => `${t.order ?? i + 1}. ${t.title} — ${clip(t.description, 100)}`));
}

function tour(n) {
  const list = graph.tour || graph.tours || [];
  const t = list.find((x, i) => String(x.order ?? i + 1) === String(n));
  if (!t) fail(`No tour step ${n}. Run: code-graph tours`);
  const files = (t.nodeIds || []).map((id) => byId.get(id)).filter(Boolean);
  print(`${t.order}. ${t.title}`, clip(t.description, 800), ...files.slice(0, limit).map(row));
}

function stats() {
  const types = {};
  for (const n of nodes) types[n.type] = (types[n.type] || 0) + 1;
  const files = new Set(nodes.filter((n) => n.type === "file").map((n) => n.filePath));
  const stale = [...changed].filter((f) => files.has(f));
  print(
    `Graph: ${relative(process.cwd(), graphFile) || graphFile}`,
    `Built: ${meta.lastAnalyzedAt || statSync(graphFile).mtime.toISOString()}${meta.gitCommitHash ? ` at ${meta.gitCommitHash.slice(0, 9)}` : ""}`,
    `Nodes: ${nodes.length} (${Object.entries(types).map(([k, v]) => `${k} ${v}`).join(", ")})`,
    `Edges: ${edges.length} · layers ${(graph.layers || []).length} · tours ${(graph.tour || graph.tours || []).length}`,
    `Changed since built: ${changed.size} files, ${stale.length} of them in the graph${stale.length > 40 ? " — consider re-running /understand" : ""}`,
  );
}

const commands = {
  where: () => where(rest),
  file: () => file(rest.join(" ")),
  impact: () => trace(rest.join(" "), "in", 2),
  deps: () => trace(rest.join(" "), "out", 1),
  layers,
  layer: () => layer(rest.join(" ")),
  tours,
  tour: () => tour(rest[0]),
  stats,
};
if (!commands[command]) fail(`Unknown command "${command}".\n\n${HELP}`);
commands[command]();
