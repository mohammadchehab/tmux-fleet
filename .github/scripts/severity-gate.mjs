#!/usr/bin/env node
// .github/scripts/severity-gate.mjs: the one place the security job's pass/fail is decided (docs/runbook/ci.md §6.2).
//
// Each scanner writes SARIF; GitHub code scanning shows everything, and this gate fails the job at or above a floor
// severity. Keeping the decision here — one readable file, no third-party action — is what makes "MED+ fails" a rule
// you can read rather than a setting you have to trust.
//
// Severity per tool, because the three report it differently:
//   gitleaks  a result is a secret found in a commit or the diff: always CRITICAL (design §6.2: "a secret in a pushed
//             branch"). Its SARIF carries no level. False positives are suppressed in .gitleaksignore, by fingerprint.
//   semgrep   result.level, else the rule's defaultConfiguration.level: error -> HIGH, warning -> MEDIUM, note -> LOW.
//   osv       the rule's properties["security-severity"] (a CVSS score, the same number GitHub reads):
//             >= 9 CRITICAL, >= 7 HIGH, >= 4 MEDIUM, below that LOW.
//
// Usage: severity-gate.mjs --floor MEDIUM --report gitleaks=path/to.sarif --report semgrep=... --report osv=...
// Exit: 0 nothing at or above the floor; 1 findings at or above it; 2 a report is missing or unreadable (a scanner
// that did not run is a failure, never a silent pass — design §6.2: "a scanner that is absent is never silently
// skipped").
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const RANK = { none: 0, note: 0, low: 1, medium: 2, high: 3, critical: 4 }
const LABEL = ['none', 'low', 'medium', 'high', 'critical']

const args = process.argv.slice(2)
let floor = RANK.medium
const reports = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--floor') floor = RANK[(args[++i] ?? '').toLowerCase()] ?? floor
  else if (a === '--report') {
    const [tool, path] = (args[++i] ?? '').split('=')
    if (!tool || !path) fail(2, `--report wants tool=path, got ${args[i]}`)
    reports.push({ tool, path })
  } else fail(2, `unknown argument ${a}`)
}
if (reports.length === 0) fail(2, 'no --report given')

const semgrepLevel = (level) => ({ error: 'high', warning: 'medium', note: 'low' })[level] ?? 'low'
const cvss = (score) => {
  const n = Number(score)
  if (!Number.isFinite(n)) return null
  if (n >= 9) return 'critical'
  if (n >= 7) return 'high'
  if (n >= 4) return 'medium'
  return 'low'
}

// A SARIF rule's properties are indexed by ruleId so osv's CVSS score can be joined back to its results.
function rulesById(sarif) {
  const byId = new Map()
  for (const run of sarif.runs ?? []) {
    for (const rule of run.tool?.driver?.rules ?? []) byId.set(rule.id, rule)
    for (const rule of run.tool?.extensions?.flatMap((e) => e.rules ?? []) ?? []) byId.set(rule.id, rule)
  }
  return byId
}

function severityOf(tool, result, rule) {
  if (tool === 'gitleaks') return 'critical'
  if (tool === 'semgrep') return semgrepLevel(result.level ?? rule?.defaultConfiguration?.level)
  if (tool === 'osv') {
    const score = rule?.properties?.['security-severity'] ?? result.properties?.['security-severity']
    return cvss(score) ?? semgrepLevel(result.level)
  }
  return semgrepLevel(result.level)
}

const findings = []
for (const { tool: label, path } of reports) {
  if (!existsSync(path)) fail(2, `${label}: no report at ${path} — the scanner did not run`)
  let sarif
  try {
    sarif = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    fail(2, `${label}: ${path} is not SARIF (${e.message})`)
  }
  // The tool is read from the report, not from the label on the command line: a mislabelled report would otherwise be
  // scored by the wrong tool's rules, which is how a secret becomes a "low".
  const driver = (sarif.runs?.[0]?.tool?.driver?.name ?? label).toLowerCase()
  const tool = ['gitleaks', 'semgrep', 'osv'].find((t) => driver.startsWith(t)) ?? driver
  const rules = rulesById(sarif)
  let seen = 0
  for (const run of sarif.runs ?? []) {
    for (const result of run.results ?? []) {
      seen++
      const rule = rules.get(result.ruleId)
      const sev = severityOf(tool, result, rule)
      const loc = result.locations?.[0]?.physicalLocation
      findings.push({
        tool,
        severity: sev,
        rule: result.ruleId ?? rule?.id ?? '?',
        file: loc?.artifactLocation?.uri ?? '?',
        line: loc?.region?.startLine ?? 0,
        message: (result.message?.text ?? '').replace(/\s+/g, ' ').slice(0, 200),
      })
    }
  }
  console.log(`${tool}: ${seen} finding(s) in ${path}`)
}

const counts = new Map(LABEL.map((s) => [s, 0]))
for (const f of findings) counts.set(f.severity, counts.get(f.severity) + 1)

const blocking = findings.filter((f) => RANK[f.severity] >= floor).sort((a, b) => RANK[b.severity] - RANK[a.severity])

const summary = LABEL.map((s) => `${s} ${counts.get(s)}`).join(', ')
console.log(`severity: ${summary} (floor: ${LABEL[floor]})`)

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = ['## Security scan', '', `Floor: **${LABEL[floor]}** and above fail the job.`, '', `| severity | count |`, '| :- | -: |']
  for (const s of [...LABEL].reverse()) lines.push(`| ${s} | ${counts.get(s)} |`)
  if (blocking.length > 0) {
    lines.push('', `### ${blocking.length} finding(s) at or above the floor`, '', '| severity | tool | rule | location |', '| :- | :- | :- | :- |')
    for (const f of blocking.slice(0, 50)) lines.push(`| ${f.severity} | ${f.tool} | \`${f.rule}\` | \`${f.file}:${f.line}\` |`)
    lines.push('', 'Every finding is also in code scanning (Security → Code scanning), where it can be dismissed with a reason.')
  }
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
  } catch {
    // the summary is a convenience; never fail the gate over it
  }
}

if (blocking.length === 0) {
  console.log('gate: nothing at or above the floor')
  process.exit(0)
}

console.error(`gate: ${blocking.length} finding(s) at or above ${LABEL[floor]}`)
for (const f of blocking) console.error(`  ${f.severity.toUpperCase()} ${f.tool} ${f.rule} ${f.file}:${f.line} — ${f.message}`)
console.error(
  '\nFix it, do not mute it. A false positive is suppressed where the tool reads it, never here:\n' +
    '  a secret that is a test fixture      .gitleaksignore, by fingerprint, with a comment saying why\n' +
    '  a semgrep rule that does not apply   `# nosemgrep: <rule-id>` on the line, with a reason\n' +
    '  a vulnerability with no fix / not scannable  an osv-scanner.toml ignore, with a reason\n' +
    'Every one of those is a reviewable diff. See docs/runbook/ci.md.',
)
process.exit(1)

function fail(code, message) {
  console.error(`severity-gate: ${message}`)
  process.exit(code)
}
