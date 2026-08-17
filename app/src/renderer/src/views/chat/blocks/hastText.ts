// Small hast helpers for the AssistantDocument `pre` override: given the hast
// tree react-markdown hands back for a fenced code block (`pre > code.language-x`,
// passed via passNode), find the inner `code` element, read its `language-x`
// class, and flatten its children back to the raw source text. Kept separate
// from ChatView.tsx so it stays independently testable and dependency-light.
import type { Element, ElementContent } from 'hast'

export function findCodeElement(node: Element | undefined): Element | undefined {
  return node?.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code'
  )
}

/** The `language-xxx` class on a code element's `className`, if any. */
export function codeLanguage(codeNode: Element | undefined): string | undefined {
  const classNames = codeNode?.properties?.className
  if (!Array.isArray(classNames)) return undefined
  const match = classNames.find(
    (value): value is string => typeof value === 'string' && value.startsWith('language-')
  )
  return match?.slice('language-'.length)
}

/** Flattens an element's descendant text nodes back into one string. */
export function hastTextContent(node: Element | ElementContent | undefined): string {
  if (!node || !('children' in node) || !node.children) return ''
  let out = ''
  for (const child of node.children) {
    if (child.type === 'text') out += child.value
    else out += hastTextContent(child)
  }
  return out
}
