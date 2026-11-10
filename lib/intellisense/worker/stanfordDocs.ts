/**
 * Documentation for the Stanford library, read from the headers' own comment
 * blocks. Most collection headers document members as
 *
 *   /*
 *    * Method: put
 *    * Usage: map.put(key, value);
 *    * ---------------------------
 *    * Associates <code>key</code> with <code>value</code> in this map.
 *    *\/
 *
 * which clang does not treat as a doc comment, so completion and hover would
 * otherwise show no docs for Map, Grid, HashMap, Stack, Queue and friends.
 */

export type StanfordDoc = { usage?: string; markdown: string };

function htmlToMarkdown(text: string): string {
  return text
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<(b|strong)>(?:<i>)?([\s\S]*?)(?:<\/i>)?<\/\1>/g, '**$2**')
    .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*')
    .replace(/<\/?(p|br)\s*\/?>/g, '\n\n')
    .replace(/<\/?(pre|ul|ol|li|em|tt|a)[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Keys: `Class.member`, `Class`, and bare `function` names. */
export function indexStanfordDocs(headers: Record<string, string>): Map<string, StanfordDoc> {
  const index = new Map<string, StanfordDoc>();
  for (const source of Object.values(headers)) {
    let currentClass: string | null = null;
    for (const m of source.matchAll(/\/\*([\s\S]*?)\*\//g)) {
      const lines = m[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, ''));
      const head = lines.find((l) => l.trim())?.trim() ?? '';
      const tag = head.match(/^(Class|Method|Function|Constructor|Destructor|Operator|Type|Constant):\s*([^\s(<]+)/);
      if (!tag) continue;
      const [, kind, rawName] = tag;
      const name = kind === 'Destructor' ? rawName.replace(/^~?/, '~') : rawName;
      const usage = lines
        .filter((l) => /^\s*Usage:/.test(l))
        .map((l) => l.replace(/^\s*Usage:\s*/, '').trim())
        .join('\n');
      const sep = lines.findIndex((l) => /^\s*-{3,}\s*$/.test(l));
      const body = lines
        .slice(sep >= 0 ? sep + 1 : 1)
        .join('\n')
        .replace(/\n{2,}/g, '\n\n')
        .split(/\n\n/)
        .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean)
        .join('\n\n');
      const doc: StanfordDoc = { usage: usage || undefined, markdown: htmlToMarkdown(body).trim() };
      if (kind === 'Class') {
        currentClass = name;
        index.set(name, doc);
      } else if (currentClass && (kind === 'Method' || kind === 'Constructor' || kind === 'Destructor' || kind === 'Operator')) {
        const key = `${currentClass}.${name}`;
        if (!index.has(key)) index.set(key, doc);
      } else if (!index.has(name)) {
        index.set(name, doc);
      }
    }
  }
  return index;
}

/** Docs as Markdown, with the usage example as a code block on top. */
export function docMarkdown(doc: StanfordDoc): string {
  return (doc.usage ? '```cpp\n' + doc.usage + '\n```\n\n' : '') + doc.markdown;
}
