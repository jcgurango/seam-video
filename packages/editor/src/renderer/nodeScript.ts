// Node-script support: a composition can carry an attached `data` node
// tagged ["seam-editor", "node-script"] whose payload is `{ scriptSrc,
// original }`. The composition's `children` + `attachments` (minus the
// script attachment itself) is the *rendered* output of running
// `scriptSrc` against `original`. The editor edits `original` and the
// rendered body is recomputed on every change.
//
// Only one script attachment is honoured per composition; we always
// pick the first one we find.

import { validate } from "@seam/core";
import type { Composition, Data, SeamFile } from "@seam/core";

export const SCRIPT_TAGS = ["seam-editor", "node-script"];

export interface ScriptPayload {
  /** JavaScript source — body of an anonymous function. Must `return` a
   *  composition node. */
  scriptSrc: string;
  /** The user-edited source-of-truth composition, before the script ran. */
  original: Composition;
}

export interface FoundScript {
  /** Position of the script attachment within `attachments`. */
  index: number;
  payload: ScriptPayload;
}

const DEFAULT_SCRIPT = "return currentNode;\n";

export function findScript(comp: Composition): FoundScript | null {
  const atts = comp.attachments;
  if (!atts) return null;
  for (let i = 0; i < atts.length; i++) {
    const att = atts[i];
    if (att.type !== "data") continue;
    const tags = att.tags ?? [];
    if (
      !tags.includes("seam-editor") ||
      !tags.includes("node-script")
    ) {
      continue;
    }
    const data = att.data;
    if (
      typeof data === "object" &&
      data !== null &&
      "scriptSrc" in data &&
      "original" in data &&
      typeof (data as { scriptSrc: unknown }).scriptSrc === "string"
    ) {
      const payload = data as ScriptPayload;
      // Validate `original` is a composition; if it's been corrupted, treat
      // as no-script (caller can decide to surface or repair).
      if (
        payload.original &&
        typeof payload.original === "object" &&
        payload.original.type === "composition"
      ) {
        return { index: i, payload };
      }
    }
  }
  return null;
}

export function hasScript(comp: Composition): boolean {
  return findScript(comp) != null;
}

/** What the editor surfaces (timeline panel, JSON tab, navigation): the
 *  pre-script `original` if a script is attached, otherwise the composition
 *  as-is. */
export function editTarget(comp: Composition): Composition {
  const script = findScript(comp);
  return script ? script.payload.original : comp;
}

/**
 * Run a script against an `original` composition and return the resulting
 * composition. Throws on any execution / validation error so callers can
 * surface a useful message.
 *
 * The execution environment is a plain `new Function(...)` with `window`
 * and `document` shadowed to `undefined`. This is a footgun-reducer, not a
 * sandbox: untrusted scripts must never be loaded.
 */
export function runScript(
  scriptSrc: string,
  original: Composition
): Composition {
  const fn = new Function(
    "currentNode",
    "window",
    "document",
    "globalThis",
    "self",
    scriptSrc
  );
  let result: unknown;
  try {
    // Pass an immutable-ish copy so accidental in-place mutations on
    // `currentNode` don't poison our stored `original`.
    const cloned = JSON.parse(JSON.stringify(original));
    result = fn(cloned, undefined, undefined, undefined, undefined);
  } catch (err) {
    throw new Error(
      `Script threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!result || typeof result !== "object") {
    throw new Error("Script must return an object (a composition node).");
  }
  if ((result as { type?: unknown }).type !== "composition") {
    throw new Error(
      `Script returned a "${
        (result as { type?: unknown }).type
      }" node; only "composition" is allowed.`
    );
  }
  // Run schema validation through validate() so we get a clear error path.
  const wrapped = result as SeamFile;
  const v = validate(wrapped);
  if (!v.success) {
    throw new Error(`Script returned an invalid composition:\n - ${v.errors.join("\n - ")}`);
  }
  return v.data as Composition;
}

/**
 * Build a composition's "compiled" form: the rendered output of running
 * the script + the script attachment carrying `{ scriptSrc, original }`.
 * The script attachment is always appended at the end of `attachments`.
 */
function makeScriptAttachment(payload: ScriptPayload): Data {
  return {
    type: "data",
    tags: SCRIPT_TAGS,
    data: payload,
    duration: 0,
  };
}

/** Recompute a script-driven composition's rendered body from `original`. */
export function compile(comp: Composition): Composition {
  const script = findScript(comp);
  if (!script) return comp;
  const rendered = runScript(script.payload.scriptSrc, script.payload.original);
  const newAttachments = [...(rendered.attachments ?? []), makeScriptAttachment(script.payload)];
  return { ...rendered, attachments: newAttachments };
}

/**
 * The user just edited `original` (e.g. via the timeline panel). Persist
 * the new `original` inside the script attachment and recompile so the
 * rendered body reflects the change.
 */
export function withUpdatedOriginal(
  comp: Composition,
  newOriginal: Composition
): Composition {
  const script = findScript(comp);
  if (!script) {
    // No script — the comp itself IS the edit target; just return the
    // new "original" verbatim.
    return newOriginal;
  }
  const newPayload: ScriptPayload = {
    scriptSrc: script.payload.scriptSrc,
    original: newOriginal,
  };
  // We rebuild from scratch: render the new original, then attach a fresh
  // script attachment carrying the new payload.
  const rendered = runScript(newPayload.scriptSrc, newPayload.original);
  return {
    ...rendered,
    attachments: [
      ...(rendered.attachments ?? []),
      makeScriptAttachment(newPayload),
    ],
  };
}

/** Replace just the scriptSrc, then recompile. */
export function withUpdatedScriptSrc(
  comp: Composition,
  newSrc: string
): Composition {
  const script = findScript(comp);
  if (!script) {
    throw new Error("withUpdatedScriptSrc: composition has no script attached.");
  }
  const newPayload: ScriptPayload = {
    scriptSrc: newSrc,
    original: script.payload.original,
  };
  const rendered = runScript(newPayload.scriptSrc, newPayload.original);
  return {
    ...rendered,
    attachments: [
      ...(rendered.attachments ?? []),
      makeScriptAttachment(newPayload),
    ],
  };
}

/**
 * Enable the script feature on a composition: snapshot it as `original`,
 * run an identity script (returns currentNode), and append the script
 * attachment.
 */
export function enableScript(comp: Composition): Composition {
  const original = comp;
  const payload: ScriptPayload = { scriptSrc: DEFAULT_SCRIPT, original };
  const rendered = runScript(payload.scriptSrc, payload.original);
  return {
    ...rendered,
    attachments: [
      ...(rendered.attachments ?? []),
      makeScriptAttachment(payload),
    ],
  };
}

/** Strip the script attachment and replace the composition body with the
 *  unrendered `original`. */
export function disableScript(comp: Composition): Composition {
  const script = findScript(comp);
  if (!script) return comp;
  return script.payload.original;
}

/**
 * Run the script one final time and replace the composition with its
 * rendered output, dropping the script attachment entirely. Useful for
 * "freezing" a script-driven composition once you're happy with the
 * result so it no longer depends on the script.
 *
 * Throws on script failure — baking with a broken script would lose the
 * `original` source-of-truth, so we refuse rather than silently using a
 * stale rendered body.
 */
export function bakeScript(comp: Composition): Composition {
  const script = findScript(comp);
  if (!script) return comp;
  return runScript(script.payload.scriptSrc, script.payload.original);
}

/**
 * Same as `withUpdatedOriginal` but doesn't throw on script failures —
 * instead leaves the rendered body in place while still bumping the
 * stored `original`. Returns the resulting composition + an optional
 * error string the caller can surface.
 *
 * The next successful script run picks up the new `original`, so once
 * the user fixes the script the rendered body catches up.
 */
export function safeWithUpdatedOriginal(
  comp: Composition,
  newOriginal: Composition
): { comp: Composition; error: string | null } {
  const script = findScript(comp);
  if (!script) {
    return { comp: newOriginal, error: null };
  }
  try {
    return { comp: withUpdatedOriginal(comp, newOriginal), error: null };
  } catch (err) {
    const newPayload: ScriptPayload = {
      scriptSrc: script.payload.scriptSrc,
      original: newOriginal,
    };
    // Keep the rendered body untouched; just patch the script attachment's
    // payload so the new `original` is preserved for the next run.
    const newAtts = (comp.attachments ?? []).map((att, i) =>
      i === script.index
        ? { ...(att as Data), data: newPayload, tags: SCRIPT_TAGS, duration: 0 }
        : att
    );
    return {
      comp: { ...comp, attachments: newAtts },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Same as `withUpdatedScriptSrc`, but reports a script error instead of
 *  throwing. */
export function safeWithUpdatedScriptSrc(
  comp: Composition,
  newSrc: string
): { comp: Composition; error: string | null } {
  const script = findScript(comp);
  if (!script) {
    return {
      comp,
      error:
        "Cannot update scriptSrc: composition has no script attached. Enable the script first.",
    };
  }
  try {
    return { comp: withUpdatedScriptSrc(comp, newSrc), error: null };
  } catch (err) {
    // Update the stored scriptSrc so the editor reflects what the user
    // typed, but don't touch the rendered body.
    const newPayload: ScriptPayload = {
      scriptSrc: newSrc,
      original: script.payload.original,
    };
    const newAtts = (comp.attachments ?? []).map((att, i) =>
      i === script.index
        ? { ...(att as Data), data: newPayload, tags: SCRIPT_TAGS, duration: 0 }
        : att
    );
    return {
      comp: { ...comp, attachments: newAtts },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
