// The new slovakhandball.sk is a Next.js site: every page carries its data inside
// the HTML as JSON, in `self.__next_f.push([1,"..."])` calls. The pieces together
// form lines like `17:[...]` (an id, a colon and JSON). This reads those lines.
// That data is much steadier than the visible layout of the page.

export class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormatError';
  }
}

const PUSH = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

/** Every JSON value of a page, by its line id. */
export function extractFlight(html) {
  let text = '';
  let pushes = 0;
  for (const match of html.matchAll(PUSH)) {
    pushes++;
    try {
      text += JSON.parse(`"${match[1]}"`);
    } catch {
      throw new FormatError('Údaje na stránke sa nepodarilo prečítať.');
    }
  }
  if (pushes === 0) throw new FormatError('Stránka nemá očakávané údaje (zväz asi zmenil web).');

  const values = {};
  for (const line of text.split('\n')) {
    const split = /^([0-9a-f]+):(.*)$/s.exec(line);
    if (!split) continue;
    try {
      values[split[1]] = JSON.parse(split[2]);
    } catch {
      // Lines that are not JSON (scripts, style references) are of no use here.
    }
  }
  return values;
}

/** The first object anywhere in [value] that has the property [key] holding the
 * kind of value [accepts] approves of, or null. */
export function findByKey(value, key, accepts = () => true, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 14) return null;
  if (!Array.isArray(value) && key in value && accepts(value[key])) return value;
  for (const child of Object.values(value)) {
    const found = findByKey(child, key, accepts, depth + 1);
    if (found) return found;
  }
  return null;
}
