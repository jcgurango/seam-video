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
import type { BinEntry, Child, Composition, SeamFile } from "./types.js";

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

/** Compile a document — bottom-up: splice bin references, recurse into
 *  children/attachments, then run scripts on each composition. */
export function compileSeamFile(doc: SeamFile): CompileResult {
  const errors: CompileError[] = [];
  const compiled = compileComposition(doc as Composition, [], errors);
  return { doc: compiled as SeamFile, errors };
}

function compileChild(
  child: Child,
  binStack: BinEntry[][],
  errors: CompileError[],
): Child {
  if (child.type !== "composition") return child;
  return compileComposition(child, binStack, errors);
}

function compileComposition(
  comp: Composition,
  callerBinStack: BinEntry[][],
  errors: CompileError[],
): Composition {
  // 1. Bin reference: replace body with the looked-up entry's body.
  //    The reference's own bin/script/spatial/timing fields stay; only
  //    `children` + `attachments` come from the entry.
  let staged: Composition = comp;
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

  // 3. Recurse children/attachments with the inner stack.
  const newChildren = staged.children.map((c) =>
    compileChild(c, innerStack, errors),
  );
  const newAttachments = staged.attachments?.map((c) =>
    compileChild(c, innerStack, errors),
  );
  staged = {
    ...staged,
    children: newChildren,
    ...(newAttachments ? { attachments: newAttachments } : {}),
  };

  // 4. Script (last): runs against `staged` with bins+descendants
  //    already resolved. Output replaces us; recompile in the caller's
  //    scope since the replacement supersedes our own bin definitions.
  if (staged.script != null) {
    try {
      const rawResult = runScript(staged.script, staged);
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

  // 5. Strip `binItem` and `script` from the compiled output — both
  //    have been consumed. `bin` survives (it's just data; harmless if
  //    no descendant references it).
  const { binItem: _bi, script: _s, ...rest } = staged;
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
