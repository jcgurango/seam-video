// Compile pass — resolves `bin` / `binItem` references and `script`
// fields on compositions into a "pure" rendered tree the resolver can
// consume.
//
// Bin lookup is lexically scoped: when a composition has `binItem: "x"`,
// we walk up to the nearest enclosing composition whose `bin` array
// contains an entry with id "x". A composition's own `bin` shadows any
// inherited entries with the same id. Bin entries are stored *raw*
// (not pre-compiled) so each reference resolves nested bin refs /
// scripts against its own surrounding scope.
//
// Scripts run last for each composition: the input is the bin-spliced,
// child-recursed composition itself. The script's output composition
// is then compiled in the parent's scope (the original composition is
// being replaced wholesale, so its own bin doesn't apply to the
// replacement).
//
// The compiled output has `binItem` and `script` stripped — the next
// compile of the same doc is a no-op. `bin` is preserved (it's
// addressable data, not action), so a downstream tool can still
// inspect the bin definitions.

import { validate } from "./validate.js";
import { expandMacros, findUnresolvedMacros } from "./macros.js";
import type {
  BaseComposition,
  BinEntry,
  Child,
  Composition,
  SeamFile,
} from "./types.js";

export interface CompileError {
  /** Hint at where the error came from. `"bin:<id>"` for a missing bin
   *  entry, `"script"` for a thrown / invalid script. */
  source: string;
  message: string;
}

export interface CompileResult {
  doc: SeamFile;
  errors: CompileError[];
}

export interface CompileOptions {
  /** When false, `script` fields are left intact on the output and not
   *  executed; bin references still splice as usual. Useful for the
   *  editor's timeline panel, which renders the user's authored body
   *  so edits map 1:1 — running the script would replace what they
   *  see with the script's output and any drag/trim writes would
   *  vanish on the next compile. Defaults to true. */
  runScripts?: boolean;
}

/** Compile a document — bottom-up:
 *    1. Expand macros (strips `composition.macros` and substitutes
 *       every `"$$NAME"` reference). Failures land in `errors` and
 *       bin/script processing is skipped.
 *    2. Splice bin references.
 *    3. Recurse into children/attachments.
 *    4. Run scripts on each composition. */
export function compileSeamFile(
  doc: SeamFile,
  options: CompileOptions = {},
): CompileResult {
  const errors: CompileError[] = [];
  const runScripts = options.runScripts ?? true;

  // Macro expansion comes first — bin / script resolution operates on
  // the post-expansion document. Failures here propagate as
  // `CompileError`s tagged "macro:<path>" so the editor can surface
  // them in the same channel as bin/script errors.
  const expanded = expandMacros(doc);
  if (!expanded.success) {
    for (const message of expanded.errors) {
      errors.push({ source: "macro", message });
    }
    return { doc, errors };
  }
  const expandedDoc = expanded.data as Composition;

  const compiled = compileComposition(
    expandedDoc,
    [],
    errors,
    runScripts,
  );
  return { doc: compiled as SeamFile, errors };
}

function compileChild(
  child: Child,
  binStack: BinEntry[][],
  errors: CompileError[],
  runScripts: boolean,
): Child {
  if (child.type !== "composition") return child;
  return compileComposition(child, binStack, errors, runScripts);
}

function compileComposition(
  comp: Composition,
  callerBinStack: BinEntry[][],
  errors: CompileError[],
  runScripts: boolean,
): Composition {
  // 1. Bin reference: replace body with the looked-up entry's body.
  //    The reference's own bin/script/spatial/timing fields stay; only
  //    `children` + `attachments` come from the entry.
  //
  //    `staged` is a working shape that — unlike the authored `Composition`
  //    union — may transiently hold `binItem` alongside `children`/
  //    `attachments` (the splice below adds them before step 5 strips
  //    `binItem`). Cast back to `Composition` at the return.
  let staged: BaseComposition & {
    children?: Child[];
    attachments?: Child[];
    binItem?: string;
  } = comp;
  if (staged.binItem != null) {
    const entry = lookupBinEntry(staged.binItem, callerBinStack);
    if (!entry) {
      errors.push({
        source: `bin:${staged.binItem}`,
        message: `Bin reference "${staged.binItem}" has no matching entry in scope.`,
      });
    } else {
      staged = {
        ...staged,
        children: entry.children,
      };
      if (entry.attachments) staged.attachments = entry.attachments;
      else delete (staged as { attachments?: unknown }).attachments;
    }
  }

  // 2. Push our own bin onto the stack for descendants. Our entries
  //    win over inherited ones with the same id (nearest-enclosing).
  const innerStack = staged.bin ? [staged.bin, ...callerBinStack] : callerBinStack;

  // 3. Recurse children/attachments with the inner stack. Tolerate a
  //    missing `children` field — a bin-ref or empty composition can
  //    legitimately omit it. The output always has `children` populated
  //    so the resolver downstream doesn't need to defensive-check.
  const inputChildren = staged.children ?? [];
  const newChildren = inputChildren.map((c) =>
    compileChild(c, innerStack, errors, runScripts),
  );
  const newAttachments = staged.attachments?.map((c) =>
    compileChild(c, innerStack, errors, runScripts),
  );
  staged = {
    ...staged,
    children: newChildren,
    ...(newAttachments ? { attachments: newAttachments } : {}),
  };

  // 4. Script (last): runs against `staged` with bins+descendants
  //    already resolved. Output replaces us; recompile in the caller's
  //    scope since the replacement supersedes our own bin definitions.
  //    `runScripts: false` skips this step and leaves the `script`
  //    field on the output so the editor's timeline panel can render
  //    the user's authored body for direct editing.
  if (staged.script != null && runScripts) {
    try {
      const rawResult = runScript(staged.script, staged as Composition);
      // Macro expansion is a one-shot, pre-validation step on the
      // *source* document. Scripts run after that and emit fresh
      // content; any "$$…" in their output never had a chance to be
      // expanded. Treat it as invalid rather than silently leaking
      // unresolved references downstream.
      const stray = findUnresolvedMacros(rawResult);
      if (stray) {
        throw new Error(
          `Script output contains an unresolved macro $$${stray.name} at ${stray.path || "<root>"}. Macros are evaluated before scripts run — script output cannot reference them.`,
        );
      }
      const v = validate(rawResult);
      if (!v.success) {
        throw new Error(
          `Script returned an invalid composition:\n - ${v.errors.join("\n - ")}`,
        );
      }
      const result = v.data as Composition;
      // Drop the script field so the recursion doesn't re-run it. Any
      // other fields on the output (including a fresh bin) are taken
      // verbatim — the output IS the replacement.
      const { script: _drop, ...withoutScript } = result;
      staged = compileComposition(
        withoutScript as Composition,
        callerBinStack,
        errors,
        runScripts,
      );
    } catch (err) {
      errors.push({
        source: "script",
        message: err instanceof Error ? err.message : String(err),
      });
      // Leave the existing (bin-spliced, child-recursed) body in place
      // so the user keeps a usable preview while they fix the script.
    }
  }

  // 5. Strip `binItem` from the compiled output (consumed). Keep
  //    `script` in panel mode (runScripts: false) so the editor knows
  //    a script is attached; strip it in normal mode. `bin` always
  //    survives — it's just addressable data.
  if (runScripts) {
    const { binItem: _bi, script: _s, ...rest } = staged;
    return rest as Composition;
  }
  const { binItem: _bi, ...rest } = staged;
  return rest as Composition;
}

function lookupBinEntry(
  id: string,
  binStack: BinEntry[][],
): BinEntry | null {
  // Walk inner-to-outer (first frame is closest scope) — first match
  // wins, so a child composition's bin shadows the parent's.
  for (const frame of binStack) {
    for (const entry of frame) {
      if (entry.id === id) return entry;
    }
  }
  return null;
}

/**
 * Run a script against a composition and return its raw output (no
 * schema validation here — the caller validates after splicing). The
 * execution environment is a plain `new Function(...)` with `window`
 * and `document` shadowed. This is a footgun-reducer, not a sandbox:
 * untrusted scripts must never be loaded.
 */
export function runScript(
  scriptSrc: string,
  currentNode: Composition,
): unknown {
  const fn = new Function(
    "currentNode",
    "window",
    "document",
    "globalThis",
    "self",
    scriptSrc,
  );
  // Deep copy so in-place mutations on `currentNode` don't poison the
  // input we still hold a reference to.
  const cloned = JSON.parse(JSON.stringify(currentNode));
  let result: unknown;
  try {
    result = fn(cloned, undefined, undefined, undefined, undefined);
  } catch (err) {
    throw new Error(
      `Script threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!result || typeof result !== "object") {
    throw new Error("Script must return an object (a composition node).");
  }
  if ((result as { type?: unknown }).type !== "composition") {
    throw new Error(
      `Script returned a "${
        (result as { type?: unknown }).type
      }" node; only "composition" is allowed.`,
    );
  }
  return result;
}
