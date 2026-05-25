// Node-script support: a composition can carry a `seam-editor-script`
// entry in its `metadata` whose value is `{ scriptSrc, original }`. The
// composition's `children` + `attachments` is the *rendered* output of
// running `scriptSrc` against `original`. The editor edits `original`
// and the rendered body is recomputed on every change.

import type { Composition } from "@seam/core";

export const SCRIPT_METADATA_KEY = "seam-editor-script";

export interface ScriptPayload {
  /** JavaScript source — body of an anonymous function. Must `return` a
   *  composition node. */
  scriptSrc: string;
  /** The user-edited source-of-truth composition, before the script ran. */
  original: Composition;
}

export interface FoundScript {
  payload: ScriptPayload;
}

const DEFAULT_SCRIPT = "return currentNode;\n";

export function findScript(comp: Composition): FoundScript | null {
  const raw = comp.metadata?.[SCRIPT_METADATA_KEY];
  if (
    !raw ||
    typeof raw !== "object" ||
    !("scriptSrc" in raw) ||
    !("original" in raw) ||
    typeof (raw as { scriptSrc: unknown }).scriptSrc !== "string"
  ) {
    return null;
  }
  const payload = raw as ScriptPayload;
  // Validate `original` is a composition; if it's been corrupted, treat
  // as no-script (caller can decide to surface or repair).
  if (
    !payload.original ||
    typeof payload.original !== "object" ||
    payload.original.type !== "composition"
  ) {
    return null;
  }
  return { payload };
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
 * Run a script against an `original` composition and return the script's
 * raw output. Throws on execution failure or if the script doesn't
 * return a composition object — but does NOT run schema validation,
 * because a script may legitimately emit bin references whose
 * `children` get spliced in by the compile pass downstream. Validation
 * is the compile pipeline's responsibility.
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
  return result as Composition;
}

/** Splice the script payload into a composition's metadata, preserving any
 *  other metadata keys already present. */
function withScriptMetadata(
  comp: Composition,
  payload: ScriptPayload
): Composition {
  return {
    ...comp,
    metadata: { ...(comp.metadata ?? {}), [SCRIPT_METADATA_KEY]: payload },
  };
}

/** Recompute a script-driven composition's rendered body from `original`. */
export function compile(comp: Composition): Composition {
  const script = findScript(comp);
  if (!script) return comp;
  const rendered = runScript(script.payload.scriptSrc, script.payload.original);
  return withScriptMetadata(rendered, script.payload);
}

/**
 * The user just edited `original` (e.g. via the timeline panel). Persist
 * the new `original` inside the metadata and recompile so the rendered
 * body reflects the change.
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
  const rendered = runScript(newPayload.scriptSrc, newPayload.original);
  return withScriptMetadata(rendered, newPayload);
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
  return withScriptMetadata(rendered, newPayload);
}

/**
 * Enable the script feature on a composition: snapshot it as `original`,
 * run an identity script (returns currentNode), and stash the payload in
 * metadata.
 */
export function enableScript(comp: Composition): Composition {
  const original = comp;
  const payload: ScriptPayload = { scriptSrc: DEFAULT_SCRIPT, original };
  const rendered = runScript(payload.scriptSrc, payload.original);
  return withScriptMetadata(rendered, payload);
}

/** Strip the script metadata and replace the composition body with the
 *  unrendered `original`. */
export function disableScript(comp: Composition): Composition {
  const script = findScript(comp);
  if (!script) return comp;
  return script.payload.original;
}

/**
 * Run the script one final time and replace the composition with its
 * rendered output, dropping the script metadata entirely. Useful for
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
    return {
      comp: withScriptMetadata(comp, newPayload),
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
    const newPayload: ScriptPayload = {
      scriptSrc: newSrc,
      original: script.payload.original,
    };
    return {
      comp: withScriptMetadata(comp, newPayload),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
