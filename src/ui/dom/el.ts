/**
 * Four lines of element building, so the panels below read as structure rather than as
 * `createElement` noise.
 *
 * `textContent`, never `innerHTML`. Everything on this page is text from a public feed, and a
 * Wikipedia article title is user-supplied text that will one day contain a tag. That is an
 * injection in a project whose entire claim is that it shows you exactly what the feed said.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | null> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

/** Replace a node's children in one go, so a panel cannot half-update. */
export function fill(node: Element, children: (Node | string)[]): void {
  node.replaceChildren(...children);
}
