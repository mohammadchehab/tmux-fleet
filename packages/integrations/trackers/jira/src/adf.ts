/**
 * Atlassian Document Format, flattened to the text a `Work` carries (§3).
 *
 * Jira Cloud's REST API v3 returns an issue's description as ADF — a JSON tree
 * of `paragraph` / `heading` / `bulletList` / `codeBlock` … nodes wrapping
 * `text` leaves — not as markdown. The fleet's `ExternalItem.body` is plain
 * text, and a Work's brief is read by a person, so this converts the tree to
 * lines instead of pasting JSON into an event.
 *
 * What it keeps: every word, in order, one block per line, list items prefixed
 * `- ` or `1. `, `@name` for mentions, a URL for an inline card, `---` for a
 * rule. What it drops: *marks* (bold, links, colours) and media — a `Work` has
 * no renderer for them, and inventing markdown would make the text look richer
 * than what any consumer of it can show.
 *
 * An unknown node is not an error. Atlassian adds node types over time, and a
 * description that came back with one still has readable text inside it, so the
 * walk descends and keeps it.
 */

type Node = Record<string, unknown>

const asNode = (value: unknown): Node | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Node) : undefined

const children = (node: Node): readonly Node[] => {
  const content = node['content']
  if (!Array.isArray(content)) return []
  return content.flatMap((child) => {
    const node = asNode(child)
    return node === undefined ? [] : [node]
  })
}

const stringField = (node: Node, field: string): string | undefined => {
  const value = node[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

const attrs = (node: Node): Node => asNode(node['attrs']) ?? {}

/**
 * A mention's text is `attrs.text` on newer payloads and `displayName` on older
 * ones, and the newer one already carries its `@`. The prefix is added only when
 * it is missing, so a mention never reads `@@ada`.
 */
const mention = (node: Node): string => {
  const raw = attrs(node)['text'] ?? attrs(node)['displayName']
  const name = typeof raw === 'string' && raw !== '' ? raw : 'someone'
  return name.startsWith('@') ? name : `@${name}`
}

/**
 * The inline nodes: text, breaks, and the atoms that stand for a name or a URL.
 * Everything else is a container and is handled by `block`.
 */
const inline = (node: Node): string => {
  switch (node['type']) {
    case 'text':
      return stringField(node, 'text') ?? ''
    case 'hardBreak':
      return '\n'
    case 'mention':
      return mention(node)
    case 'emoji':
    case 'status':
      return stringField(attrs(node), 'text') ?? ''
    case 'inlineCard':
      return stringField(attrs(node), 'url') ?? ''
    case 'mediaInline':
    case 'media':
      return ''
    default:
      // A mark, or a container that reached the inline walk: keep its words.
      return children(node).map(inline).join('')
  }
}

const inner = (node: Node): string => children(node).map(inline).join('')

/** Blocks that end a line; a paragraph inside a list item still ends its line. */
const line = (node: Node): string => `${inner(node)}\n`

/** `- ` or `1. ` in front of a list item's first line, and only its first line. */
const item = (prefix: string, node: Node): string => {
  const text = block(node)
  return text.startsWith(prefix) ? text : `${prefix}${text}`
}

/** One node as text, with block boundaries as newlines. */
const block = (node: Node): string => {
  const content = children(node)
  switch (node['type']) {
    case 'text':
    case 'hardBreak':
    case 'mention':
    case 'emoji':
    case 'status':
    case 'inlineCard':
    case 'mediaInline':
    case 'media':
      return inline(node)
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'panel':
    case 'expand':
    case 'tableRow':
    case 'tableHeader':
    case 'tableCell':
      return line(node)
    case 'codeBlock':
      // Verbatim: its children are `text` nodes whose whitespace is the code.
      return `\n${content.map(inline).join('')}\n\n`
    case 'rule':
      return '\n---\n\n'
    case 'listItem':
    case 'taskItem':
      return line(node)
    case 'bulletList':
      return `${content.map((child) => item('- ', child)).join('')}\n`
    case 'orderedList': {
      const ordered = content.map((child, index) => item(`${index + 1}. `, child)).join('')
      return `${ordered}\n`
    }
    case 'mediaGroup':
      return ''
    default: {
      // `doc`, `table`, `taskList`, and anything Atlassian adds later: descend.
      const walked = content.map(block).join('')
      return walked === '' ? inline(node) : walked
    }
  }
}

/** Collapse the blank lines the block walk leaves behind, without touching indentation. */
const tidy = (text: string): string =>
  text
    .split('\n')
    .map((row) => row.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/**
 * Text as the ADF document API v3 wants it back: one `paragraph` per line.
 *
 * This is the narrow inverse of `adfToText`, and deliberately not a markdown
 * parser. A note the fleet writes is prose — a phrase and a sentence or two —
 * and the only structure ADF must be given is the structure prose has: lines.
 * Reading the result with `adfToText` gives the input back, which is what makes
 * `comment` able to recognise a note the ticket already carries.
 *
 * A blank line is not a paragraph: ADF has no empty `paragraph`, and an empty
 * `text` node is rejected by Jira.
 */
export const textToAdf = (text: string): Node => ({
  type: 'doc',
  version: 1,
  content: text
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row !== '')
    .map((row) => ({ type: 'paragraph', content: [{ type: 'text', text: row }] })),
})

/**
 * An ADF document as text. A description that is already a string — which is
 * what Server / Data Center's API v2 returns, and what a hand-written fixture
 * may hold — is passed through tidied rather than refused.
 */
export const adfToText = (description: unknown): string | undefined => {
  if (typeof description === 'string') {
    const tidied = tidy(description)
    return tidied === '' ? undefined : tidied
  }
  const document = asNode(description)
  if (document === undefined) return undefined
  const text = tidy(block(document))
  return text === '' ? undefined : text
}
