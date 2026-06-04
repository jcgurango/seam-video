// Editor helpers for the composition `script` field. The field is just
// a JavaScript source string; the compile pass (in @seam/core) runs it
// at resolve time. Unlike the old metadata-payload form, there's no
// separate `original` snapshot — the composition's own
// `children`/`attachments` is the script's input, and the script's
// output replaces it during compile.

import { runScript } from "@seam/core";
import type { Composition } from "@seam/core";

const DEFAULT_SCRIPT = "return currentNode;\n";

export function hasScript(comp: Composition): boolean {
  return typeof comp.script === "string";
}

export function getScript(comp: Composition): string | null {
  return typeof comp.script === "string" ? comp.script : null;
}

/** Identity edit target — there's no shadow `original` any more. Kept
 *  as a function so existing call sites can pass through it unchanged
 *  while the editor catches up to the simpler model. */
export function editTarget(comp: Composition): Composition {
  return comp;
}

/** Set / replace the script source on a composition. */
export function withUpdatedScriptSrc(
  comp: Composition,
  newSrc: string,
): Composition {
  return { ...comp, script: newSrc };
}

/** Attach an identity script (`return currentNode`) to a composition,
 *  exposing the script editor for the user. */
export function enableScript(comp: Composition): Composition {
  return { ...comp, script: DEFAULT_SCRIPT };
}

/** Drop the script field, leaving the composition's authored body intact. */
export function disableScript(comp: Composition): Composition {
  if (comp.script == null) return comp;
  const { script: _drop, ...rest } = comp;
  return rest as Composition;
}

/** Run the script once and replace the composition with its output,
 *  dropping the script field entirely. Throws on script failure. */
export function bakeScript(comp: Composition): Composition {
  if (comp.script == null) return comp;
  const result = runScript(comp.script, comp) as Composition;
  const { script: _drop, ...rest } = result;
  return rest as Composition;
}

/** Try a script update and report any error string without throwing. */
export function safeWithUpdatedScriptSrc(
  comp: Composition,
  newSrc: string,
): { comp: Composition; error: string | null } {
  if (typeof comp.script !== "string") {
    return {
      comp,
      error:
        "Cannot update script: composition has no script attached. Enable it first.",
    };
  }
  // The update itself can't fail — the compile pass runs the script
  // later. Match the old return shape so call sites stay stable.
  return { comp: withUpdatedScriptSrc(comp, newSrc), error: null };
}
