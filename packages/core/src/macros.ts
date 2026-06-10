// Macros — a pre-validation substitution pass.
//
// Compositions may carry an optional `macros: { NAME: value, ... }`
// field. Anywhere a string `"$$NAME"` appears in the document, the
// expander walks up the composition tree to find the nearest enclosing
// `macros.NAME` definition and substitutes its value. Lookup is
// lexically scoped — *not* run-time — so a `binItem`'s body resolves
// macros against the composition that DEFINES the bin entry, not the
// composition where the bin reference lives.
//
// Substitution rules:
//   • `"$$NAME"` as a scalar (object value, root, etc.): replaced with
//     the looked-up value. If that value is an array, it's an error —
//     array macros must be used inside an array.
//   • `"$$NAME"` as an array element with an array-valued macro: each
//     element of the macro value is spliced into the host array.
//   • `"$$NAME"` as an array element with a non-array macro: appears
//     as a single element.
//
// Evaluation is *lazy and memoized*. Each macro's raw value is stored
// in its block's scope alongside the scope chain that was active when
// the block was opened — that chain includes the block itself, so a
// macro can reference siblings in the same block. The first time a
// macro is looked up its raw value is walked; subsequent lookups
// return the cached evaluated value. Re-entry while a macro is mid-
// evaluation is a cycle error.
//
// The `macros` field is stripped from the expanded output. Downstream
// validation/compile see a clean tree with no `$$…` strings; scripts
// emitting `$$…` post-compile are flagged separately by the compile
// pass via `findUnresolvedMacros`.

const MACRO_REF = /^\$\$([A-Za-z_][A-Za-z0-9_]*)$/;

export interface MacroExpandResult {
  success: boolean;
  data?: unknown;
  errors: string[];
}

interface MacroEntry {
  raw: unknown;
  /** Scope chain active when this macro's block was opened. Includes
   *  the block itself (so sibling references resolve). */
  defScopes: ReadonlyArray<Scope>;
  /** Path where this macro was defined — used for error messages
   *  pointing at the bad raw value rather than the use site. */
  defPath: string;
  evaluated?: unknown;
  hasEvaluated: boolean;
  evaluating: boolean;
}

type Scope = Map<string, MacroEntry>;

/** Expand all macro references in `doc`. Returns `{success, data}` on
 *  success or `{success: false, errors}` listing every unresolved
 *  reference and array-misuse spot. */
export function expandMacros(doc: unknown): MacroExpandResult {
  const errors: string[] = [];
  const data = walk(doc, [], "", errors);
  if (errors.length > 0) return { success: false, errors };
  return { success: true, data, errors: [] };
}

/** Scan a value tree for any leftover `"$$NAME"` strings. Used by the
 *  compile pass on script output (scripts run after expansion, so any
 *  macro string in their output is invalid). Returns the first offender
 *  as a `{path, name}` pair, or `null` if the tree is clean. */
export function findUnresolvedMacros(
  node: unknown,
  basePath = "",
): { path: string; name: string } | null {
  if (typeof node === "string") {
    const m = node.match(MACRO_REF);
    return m ? { path: basePath, name: m[1] } : null;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = findUnresolvedMacros(
        node[i],
        `${basePath}[${i}]`,
      );
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const next = basePath === "" ? key : `${basePath}.${key}`;
      const found = findUnresolvedMacros(value, next);
      if (found) return found;
    }
  }
  return null;
}

function walk(
  node: unknown,
  scopes: ReadonlyArray<Scope>,
  path: string,
  errors: string[],
): unknown {
  if (typeof node === "string") {
    const m = node.match(MACRO_REF);
    if (!m) return node;
    const value = resolve(m[1], scopes, path, errors);
    if (value === SENTINEL_FAILED) return node;
    if (Array.isArray(value)) {
      errors.push(
        `${path || "<root>"}: macro $$${m[1]} is an array — array macros must be used inside an array (e.g. ["${node}"])`,
      );
      return node;
    }
    return value;
  }

  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      const childPath = `${path}[${i}]`;
      if (typeof item === "string") {
        const m = item.match(MACRO_REF);
        if (m) {
          const value = resolve(m[1], scopes, childPath, errors);
          if (value === SENTINEL_FAILED) continue;
          if (Array.isArray(value)) {
            // Splice — preserve element identity verbatim (already
            // expanded by resolve(), so no re-walk needed).
            for (const v of value) out.push(v);
          } else {
            out.push(value);
          }
          continue;
        }
      }
      out.push(walk(item, scopes, childPath, errors));
    }
    return out;
  }

  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    // Composition with a `macros` block contributes a new scope frame.
    // Entries store raw values + a back-reference to the scope chain
    // including this new block, so siblings see each other when their
    // values are evaluated lazily.
    let innerScopes = scopes;
    if (
      obj.type === "composition" &&
      obj.macros &&
      typeof obj.macros === "object" &&
      !Array.isArray(obj.macros)
    ) {
      const block = obj.macros as Record<string, unknown>;
      const newScope: Scope = new Map();
      innerScopes = [newScope, ...scopes];
      for (const [name, raw] of Object.entries(block)) {
        newScope.set(name, {
          raw,
          defScopes: innerScopes,
          defPath: `${path}${path ? "." : ""}macros.${name}`,
          hasEvaluated: false,
          evaluating: false,
        });
      }
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === "macros" && obj.type === "composition") {
        // Strip from output — the expanded values are inlined at every
        // use site. Keeping the field would force the schema to allow
        // it (or fail strict validation).
        continue;
      }
      const childPath = path === "" ? key : `${path}.${key}`;
      out[key] = walk(value, innerScopes, childPath, errors);
    }
    return out;
  }

  return node;
}

/** Sentinel returned by resolve() when lookup failed and an error was
 *  pushed. Callers should pass through without further substitution. */
const SENTINEL_FAILED = Symbol("macro-failed");

function resolve(
  name: string,
  scopes: ReadonlyArray<Scope>,
  usePath: string,
  errors: string[],
): unknown {
  const entry = findEntry(name, scopes);
  if (!entry) {
    errors.push(`${usePath || "<root>"}: undefined macro $$${name}`);
    return SENTINEL_FAILED;
  }
  if (entry.hasEvaluated) return entry.evaluated;
  if (entry.evaluating) {
    errors.push(
      `${usePath || "<root>"}: macro $$${name} forms a cycle (referenced while being evaluated)`,
    );
    return SENTINEL_FAILED;
  }
  entry.evaluating = true;
  const evaluated = walk(entry.raw, entry.defScopes, entry.defPath, errors);
  entry.evaluating = false;
  entry.hasEvaluated = true;
  entry.evaluated = evaluated;
  return evaluated;
}

function findEntry(name: string, scopes: ReadonlyArray<Scope>): MacroEntry | null {
  for (const scope of scopes) {
    const entry = scope.get(name);
    if (entry) return entry;
  }
  return null;
}
