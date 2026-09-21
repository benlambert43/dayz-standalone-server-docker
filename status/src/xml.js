// A small, tolerant, non-validating XML reader.
//
// Mission files are hand-edited by server admins all day long, so the goal here is to get
// useful data out of a slightly broken file rather than to be correct about XML. Unknown
// constructs are skipped, unclosed elements are closed at the end of the document, and a
// stray "&" is left alone instead of raising.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([A-Za-z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return attrs;
}

/** Parse a whole document into a tree of { name, attrs, children, text }. */
export function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const src = String(text);
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { appendText(stack, src.slice(i)); break; }
    if (lt > i) appendText(stack, src.slice(i, lt));

    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      appendText(stack, src.slice(lt + 9, e < 0 ? src.length : e), true);
      i = e < 0 ? src.length : e + 3; continue;
    }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt); i = e < 0 ? src.length : e + 2; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }

    const gt = findTagEnd(src, lt);
    if (gt < 0) { appendText(stack, src.slice(lt)); break; }
    const inner = src.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === '/') {
      const name = inner.slice(1).trim();
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) { stack.length = d; break; }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const sp = body.search(/[\s/]/);
    const name = (sp < 0 ? body : body.slice(0, sp)).trim();
    if (!name) continue;
    const node = { name, attrs: sp < 0 ? {} : parseAttrs(body.slice(sp)), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function findTagEnd(src, from) {
  let quote = null;
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

function appendText(stack, chunk, literal = false) {
  const node = stack[stack.length - 1];
  const s = literal ? chunk : decodeEntities(chunk);
  if (s.trim() || node.text) node.text += s;
}

// ------------------------------------------------------------------ helpers --
export function children(node, name) {
  return node ? node.children.filter((c) => !name || c.name === name) : [];
}
export function child(node, name) {
  return node ? node.children.find((c) => c.name === name) || null : null;
}
export function textOf(node) { return node ? node.text.trim() : ''; }
export function numOf(node, dflt = null) {
  const v = Number(textOf(node));
  return Number.isFinite(v) ? v : dflt;
}
/** First element with this name anywhere below `node` (documents nest inconsistently). */
export function find(node, name) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = find(c, name);
    if (deep) return deep;
  }
  return null;
}
