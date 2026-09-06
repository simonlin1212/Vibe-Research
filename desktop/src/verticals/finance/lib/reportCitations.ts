import type { Root, RootContent, Text, Link } from "mdast";

const ID = /^(?:ev|calc)-[a-zA-Z0-9-]+$/;

/** Only the first column of backend-generated appendix rows is an identity.
 * Mentions in prose, input references, and fenced examples are not targets. */
export function appendixIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker?.[1]) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const id = line.match(/^\|\s*((?:ev|calc)-[a-zA-Z0-9-]+)\s*\|/)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

/** Transform text nodes only, never HTML, code, existing links or images. */
export function citationPlugin(ids: Set<string>, prefix: string, appendix = false) {
  return () => (tree: Root) => {
    const anchored = new Set<string>();
    function visit(parent: Root | RootContent) {
      if (!("children" in parent) || ["link", "linkReference", "image", "imageReference"].includes(parent.type)) return;
      if (appendix && parent.type === "tableRow") {
        const cell = parent.children[0];
        const first = cell?.children.length === 1 ? cell.children[0] : null;
        const id = first?.type === "text" ? first.value.trim() : "";
        if (ID.test(id) && ids.has(id) && !anchored.has(id)) {
          parent.data = { ...parent.data, hProperties: { id: `${prefix}${id}`, tabIndex: -1 } };
          anchored.add(id);
        }
      }
      const children: RootContent[] = [];
      for (const child of parent.children) {
        if (child.type !== "text") { visit(child); children.push(child); continue; }
        const matches = [...child.value.matchAll(/(?<![a-zA-Z0-9_-])(?:ev|calc)-[a-zA-Z0-9-]+(?![a-zA-Z0-9_-])/g)];
        let at = 0;
        for (const match of matches) {
          if (!ids.has(match[0])) continue;
          const start = match.index!;
          children.push({ type: "text", value: child.value.slice(at, start) } as Text);
          children.push({ type: "link", url: `#${prefix}${match[0]}`, title: `定位证据 ${match[0]}`,
            children: [{ type: "text", value: match[0] }] } as Link);
          at = start + match[0].length;
        }
        children.push({ ...child, value: child.value.slice(at) });
      }
      // Text replacement preserves each parent's phrasing/content category.
      parent.children = children as typeof parent.children;
    }
    visit(tree);
  };
}
