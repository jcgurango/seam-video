/**
 * JSON.stringify(_, null, 2)-compatible formatter that also records the
 * character offset of every element of every "children" / "attachments"
 * array it encounters, keyed by its dotted JSON path:
 *
 *   children.<i>
 *   attachments.<i>
 *   bin.<i>.children.<i>
 *   …
 *
 * Recording at any depth lets the JSON editor jump into nested
 * surfaces — e.g. a bin entry's children show up under
 * `bin.N.children.M`.
 *
 * Output is byte-identical to JSON.stringify(value, null, 2) for the data
 * shapes we ship (no NaN/Infinity, no functions, no class instances).
 */

export interface FormatResult {
  text: string;
  /** path key → start offset of that element's first character. */
  locations: Map<string, number>;
}

export function formatJsonWithLocations(
  value: unknown,
  indent = 2
): FormatResult {
  const locations = new Map<string, number>();
  let out = "";
  const pad = (depth: number) => " ".repeat(depth * indent);

  const append = (s: string) => {
    out += s;
  };

  const emitString = (s: string) => append(JSON.stringify(s));

  function emitValue(v: unknown, depth: number, path: string): void {
    if (v === null) {
      append("null");
      return;
    }
    const t = typeof v;
    if (t === "string") {
      emitString(v as string);
      return;
    }
    if (t === "number" || t === "boolean") {
      append(String(v));
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        append("[]");
        return;
      }
      append("[");
      for (let i = 0; i < v.length; i++) {
        if (i > 0) append(",");
        append("\n" + pad(depth + 1));
        emitValue(v[i], depth + 1, `${path}.${i}`);
      }
      append("\n" + pad(depth) + "]");
      return;
    }
    if (t === "object") {
      const entries = Object.entries(v as object).filter(
        ([, x]) => x !== undefined
      );
      if (entries.length === 0) {
        append("{}");
        return;
      }
      append("{");
      for (let i = 0; i < entries.length; i++) {
        const [k, val] = entries[i];
        if (i > 0) append(",");
        append("\n" + pad(depth + 1));
        emitString(k);
        append(": ");
        const childPath = path === "" ? k : `${path}.${k}`;
        // Capture per-element offsets for any "children" / "attachments"
        // array we encounter, regardless of depth.
        if (
          (k === "children" || k === "attachments") &&
          Array.isArray(val)
        ) {
          if (val.length === 0) {
            append("[]");
            continue;
          }
          append("[");
          for (let j = 0; j < val.length; j++) {
            if (j > 0) append(",");
            append("\n" + pad(depth + 2));
            const elementPath = `${childPath}.${j}`;
            locations.set(elementPath, out.length);
            emitValue(val[j], depth + 2, elementPath);
          }
          append("\n" + pad(depth + 1) + "]");
        } else {
          emitValue(val, depth + 1, childPath);
        }
      }
      append("\n" + pad(depth) + "}");
      return;
    }
    append("null");
  }

  emitValue(value, 0, "");
  return { text: out, locations };
}
