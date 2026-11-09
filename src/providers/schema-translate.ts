/**
 * Translate canonical Draft 2020-12 contracts to each provider's supported JSON-schema subset.
 * The canonical contract is still used for local validation of every response.
 */
type S = Record<string, any>;

function nullableUnion(s: S): S | null {
  if (Array.isArray(s.type)) {
    const { type, ...rest } = s;
    return { anyOf: type.map((t: string) => (t === 'null' ? { type: 'null' } : { ...rest, type: t })) };
  }
  if (Array.isArray(s.enum) && s.enum.includes(null)) {
    const { enum: e, ...rest } = s;
    return { anyOf: [{ ...rest, type: rest.type ?? 'string', enum: e.filter((x: unknown) => x !== null) }, { type: 'null' }] };
  }
  return null;
}

function walk(s: unknown, drop: (k: string, node: S) => boolean, visit: (node: S) => S): unknown {
  if (Array.isArray(s)) return s.map((x) => walk(x, drop, visit));
  if (!s || typeof s !== 'object') return s;
  let node: S = {};
  for (const [k, v] of Object.entries(s as S)) {
    if (drop(k, s as S)) continue;
    if (k === 'properties' || k === '$defs') node[k] = Object.fromEntries(Object.entries(v as S).map(([pk, pv]) => [pk, walk(pv, drop, visit)]));
    else node[k] = walk(v, drop, visit);
  }
  node = visit(node);
  return node;
}

/** TwelveLabs analyze: no additionalProperties, maxItems, uniqueItems, string length or number bounds; anyOf only. */
export function toPegasusSchema(canonical: S): S {
  return walk(canonical, (k, n) => ['$schema', '$id', 'title', 'additionalProperties', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'const'].includes(k) || ((k === 'minimum' || k === 'maximum') && n.type !== 'integer'), (n) => nullableUnion(n) ?? n) as S;
}

/** Gemini responseJsonSchema: enum for strings/numbers only, so null-including enums become anyOf. */
export function toGeminiSchema(canonical: S): S {
  return walk(canonical, (k) => ['$schema', '$id', 'title', 'const'].includes(k), (n) => nullableUnion(n) ?? n) as S;
}
