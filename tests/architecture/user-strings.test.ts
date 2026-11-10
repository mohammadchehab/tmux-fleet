// tests/architecture/user-strings.test.ts — a user never sees a design-doc section reference.
//
// Every string a user can read (CLI help, a refusal, an event reason, a brief, a PR body) belongs to
// the fleet, not to docs/design/fleet-v2-architecture.md; "(§10)" is noise in a message that is read
// without the design doc open. So the build fails if a string literal under apps/ or packages/ carries
// one. Comments and docs are out of scope: a comment cites the section on purpose.
//
// The scan is a parse, not a grep: a comment is a different node from a string, so a comment that cites
// §10 does not trip this and a literal that does is not missed.
//
// Run: node --test tests/   (task test at the repo root runs this and the v1 suite)

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SECTION_MARK = '§'

export interface SectionRef {
  /** POSIX path from the repo root. */
  file: string
  line: number
  /** The literal's text, newlines flattened to keep one finding on one line. */
  text: string
}

type TextNode =
  | ts.StringLiteral
  | ts.NoSubstitutionTemplateLiteral
  | ts.TemplateHead
  | ts.TemplateMiddle
  | ts.TemplateTail
  | ts.JsxText

/** A node that carries text a reader sees: a string, a template chunk, or JSX text. */
function isTextNode(node: ts.Node): node is TextNode {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  )
}

/** String literals (and template chunks and JSX text) in `source` that carry a section reference. */
export function sectionRefsIn(source: string, file = 'inline.ts'): SectionRef[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const found: SectionRef[] = []

  const visit = (node: ts.Node): void => {
    if (isTextNode(node) && node.text.includes(SECTION_MARK)) {
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
      found.push({ file, line: line + 1, text: node.text.replace(/\s+/g, ' ').trim() })
    } else {
      ts.forEachChild(node, visit)
    }
  }

  visit(parsed)
  return found
}

/** Shipped sources: a file under apps/ or packages/ that lives in a `src/` directory. */
function isSourceFile(file: string): boolean {
  if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) return false
  const parts = file.split('/')
  if (parts.includes('test') || parts.includes('node_modules') || parts.includes('dist')) return false
  return parts.includes('src')
}

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(where: string): Promise<void> {
    const entries = await readdir(join(REPO_ROOT, where), { withFileTypes: true })
    for (const entry of entries) {
      const path = posix.join(where, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        await walk(path)
      } else if (isSourceFile(path)) {
        found.push(path)
      }
    }
  }
  try {
    await walk(dir)
  } catch {
    // a phase that has not created this top-level folder yet
  }
  return found.sort()
}

test('no string a user can see cites a design-doc section', async () => {
  const files = [...(await sourceFiles('apps')), ...(await sourceFiles('packages'))]
  assert.ok(files.length > 100, `the scan found only ${files.length} source files`)

  const found: SectionRef[] = []
  for (const file of files) {
    found.push(...sectionRefsIn(await readFile(join(REPO_ROOT, file), 'utf8'), file))
  }

  const report = found.map((ref) => `${ref.file}:${ref.line}  ${ref.text}`).join('\n')
  assert.deepEqual(found, [], `a user-facing string carries a section reference:\n${report}`)
})

test('the scan sees a literal and not a comment', () => {
  const source = [
    '// a comment may cite §10 on purpose',
    '/** and a doc comment may cite (§5.2, §6) */',
    'const help = `fleet send <peer> <kind> <body>   message a peer (§7)`',
    "const clean = 'nothing to see'",
  ].join('\n')

  const found = sectionRefsIn(source)
  assert.equal(found.length, 1)
  assert.equal(found[0]?.line, 3)
  assert.match(found[0]?.text ?? '', /message a peer \(§7\)/)
})
