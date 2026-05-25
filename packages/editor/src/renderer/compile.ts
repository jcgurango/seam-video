// Universal compile pass — turns an "edited surface" document (which may
// have intentionally-empty bodies on script or bin-reference compositions)
// into a fully-rendered one. Runs the script attached to any composition
// against its `original` and splices each bin reference's body from the
// root bin. Errors are collected rather than thrown so a single bad
// script or missing bin entry doesn't lose the rest of the document.

import { validate } from "@seam/core";
import type { Child, Composition, SeamFile } from "@seam/core";
import {
  BIN_METADATA_KEY,
  applyBinItemBody,
  binReferenceId,
  findBin,
  findBinItem,
  isBinReference,
  type BinEntry,
} from "./nodeBin.js";
import {
  SCRIPT_METADATA_KEY,
  findScript,
  runScript,
} from "./nodeScript.js";

export interface CompileError {
  /** Hint at where the error came from. `"bin:<id>"` for a missing bin
   *  entry, `"script"` for a thrown script. */
  source: string;
  message: string;
}

export interface CompileResult {
  doc: SeamFile;
  errors: CompileError[];
}

/** Compile a document — walk it bottom-up, running every script and
 *  resolving every bin reference. The result has all rendered bodies
 *  back in place even if the input had them stripped.
 *
 *  Bin entries are just `{children, attachments?}` bodies, not full
 *  compositions, so nothing inside a bin entry runs at compile time —
 *  scripts and bin references inside bin bodies are spliced verbatim
 *  and recursively compiled in their landing position on the next
 *  walker step. */
export function compileDocument(doc: SeamFile): CompileResult {
  const errors: CompileError[] = [];
  const bin = findBin(doc);
  const compiled = compileComposition(doc as Composition, bin, errors, []);
  return { doc: compiled as SeamFile, errors };
}

function compileChild(
  child: Child,
  bin: BinEntry[],
  errors: CompileError[],
  path: string[],
): Child {
  if (child.type !== "composition") return child;
  return compileComposition(child, bin, errors, path);
}

function compileComposition(
  comp: Composition,
  bin: BinEntry[],
  errors: CompileError[],
  path: string[],
): Composition {
  // Bin reference wins over any script attached to the same composition
  // — having both would mean two different compilers racing for the
  // same children/attachments, which is never what the user wants.
  // Splice the bin body in first, then fall through to the recurse step
  // so anything inside the spliced body that's itself a script or bin
  // reference also gets compiled in its landing position.
  let staged: Composition = comp;
  if (isBinReference(staged)) {
    const id = binReferenceId(staged)!;
    const entry = findBinItem(bin, id);
    if (!entry) {
      errors.push({
        source: `bin:${id}`,
        message: `Bin reference "${id}" has no matching entry; leaving body as-is.`,
      });
    } else {
      staged = applyBinItemBody(staged, entry);
    }
  }

  // Recurse into children/attachments so nested scripts / bin refs
  // resolve before this node's own script runs against its `original`
  // (which can itself contain compositions).
  const newChildren = (staged.children ?? []).map((c) =>
    compileChild(c, bin, errors, path),
  );
  const newAttachments = staged.attachments?.map((c) =>
    compileChild(c, bin, errors, path),
  );
  let resolved: Composition = {
    ...staged,
    children: newChildren,
    attachments: newAttachments,
  };

  // Bin reference + script on the same node: bin already won above, so
  // skip the script run entirely. The script payload stays in metadata
  // for round-trip / future un-binning.
  if (isBinReference(resolved)) return resolved;

  const script = findScript(resolved);
  if (script) {
    const compiledOriginal = compileComposition(
      script.payload.original,
      bin,
      errors,
      [...path, "script-original"],
    );

    // Minimise what we hand back into metadata storage: bin reference
    // bodies inside `original` are dead weight on disk because compile
    // re-splices them on every read. The user-authored body of `original`
    // is preserved — only bin references lose their (recoverable)
    // children/attachments. Independent of whether the script runs
    // cleanly, since stripping doesn't depend on the run.
    const storedOriginal = stripBinReferenceBodies(script.payload.original);
    const storedMetadata = {
      ...(resolved.metadata ?? {}),
      [SCRIPT_METADATA_KEY]: { ...script.payload, original: storedOriginal },
    };

    try {
      const rawRendered = runScript(
        script.payload.scriptSrc,
        compiledOriginal,
      );
      // The script's output may itself contain bin references — splice
      // their bodies in before validating, otherwise a script that
      // emits bin refs would always fail the children.min(1) schema
      // check on the stripped reference compositions.
      const rendered = spliceBinReferencesIn(rawRendered, bin);
      const v = validate(rendered);
      if (!v.success) {
        throw new Error(
          `Script returned an invalid composition:\n - ${v.errors.join("\n - ")}`,
        );
      }
      // Keep the reference's own metadata (so the script payload stays
      // attached and any extra keys survive); overwrite only the
      // rendered structural fields.
      resolved = {
        ...(v.data as Composition),
        metadata: storedMetadata,
      };
    } catch (err) {
      errors.push({
        source: "script",
        message: err instanceof Error ? err.message : String(err),
      });
      // Leave the existing body in place so the user keeps the last
      // good render while they fix the script.
      resolved = { ...resolved, metadata: storedMetadata };
    }
  }

  return resolved;
}

/** Recursively splice bin entry bodies into every bin-reference
 *  composition in the tree. Used to fill bodies into a script's raw
 *  output so schema validation can pass — unresolved references are
 *  left as-is (validation will then reject them). */
function spliceBinReferencesIn(comp: Composition, bin: BinEntry[]): Composition {
  let next: Composition = comp;
  if (isBinReference(next)) {
    const id = binReferenceId(next)!;
    const entry = findBinItem(bin, id);
    if (entry) next = applyBinItemBody(next, entry);
  }
  const newChildren = next.children?.map((c) =>
    c.type === "composition" ? spliceBinReferencesIn(c, bin) : c,
  );
  const newAttachments = next.attachments?.map((c) =>
    c.type === "composition" ? spliceBinReferencesIn(c, bin) : c,
  );
  if (newChildren) next = { ...next, children: newChildren };
  if (newAttachments) next = { ...next, attachments: newAttachments };
  return next;
}

/** Drop `children` / `attachments` off every bin-reference composition
 *  in the tree. Recurses into children, attachments, and any nested
 *  script payload's `original`. Plain compositions are preserved as-is
 *  (we need their body for the script to operate on, and for nested
 *  scripts we keep their last-rendered output as a fallback). */
function stripBinReferenceBodies(comp: Composition): Composition {
  let next: Composition = comp;
  if (isBinReference(next)) {
    const { children: _c, attachments: _a, ...rest } = next;
    next = rest as Composition;
  }

  // Walk into any script payload's original first, so a binref-bearing
  // original-inside-an-original also gets stripped.
  const scriptPayload = next.metadata?.[SCRIPT_METADATA_KEY];
  if (
    scriptPayload &&
    typeof scriptPayload === "object" &&
    "original" in (scriptPayload as Record<string, unknown>)
  ) {
    const payload = scriptPayload as { scriptSrc: string; original: unknown };
    const orig = payload.original;
    if (
      orig &&
      typeof orig === "object" &&
      (orig as { type?: unknown }).type === "composition"
    ) {
      const strippedOriginal = stripBinReferenceBodies(orig as Composition);
      if (strippedOriginal !== orig) {
        next = {
          ...next,
          metadata: {
            ...(next.metadata ?? {}),
            [SCRIPT_METADATA_KEY]: { ...payload, original: strippedOriginal },
          },
        };
      }
    }
  }

  const newChildren = next.children?.map((c) =>
    c.type === "composition" ? stripBinReferenceBodies(c) : c,
  );
  const newAttachments = next.attachments?.map((c) =>
    c.type === "composition" ? stripBinReferenceBodies(c) : c,
  );
  if (newChildren) next = { ...next, children: newChildren };
  if (newAttachments) next = { ...next, attachments: newAttachments };
  return next;
}

/** Strip the rendered body off any script-/bin-bearing composition so the
 *  JSON editor shows only what the user actually authors. Recurses so
 *  nested script/bin compositions inside an edited node also get
 *  stripped — including the `original` held inside a script payload,
 *  which is itself a composition that can carry further script / bin
 *  metadata. Plain compositions are left untouched.
 *
 *  Non-root nodes also have `seam-editor-bin` removed from their
 *  metadata: the bin is a root-only concept and `enableScript` snapshots
 *  the root composition (bin and all) into the script payload's
 *  `original`, so without this strip the user would see (and could
 *  accidentally edit) a stale copy of the bin nested inside the script
 *  metadata. */
export function stripForJsonEditing(
  node: unknown,
  options: { isRoot?: boolean } = {},
): unknown {
  if (!node || typeof node !== "object") return node;
  const obj = node as { type?: unknown };
  if (obj.type !== "composition") return node;
  const comp = node as Composition;
  const isRoot = options.isRoot ?? false;

  const scriptPayload = comp.metadata?.[SCRIPT_METADATA_KEY];
  const hasScript = scriptPayload != null;
  const isBinRef = isBinReference(comp);

  let stripped: Composition = comp;
  if (hasScript || isBinRef) {
    // Drop the rendered structural fields — they're regenerated on save.
    const { children: _c, attachments: _a, ...rest } = comp;
    stripped = rest as Composition;
  }

  // Drop bin metadata when not at root. Anywhere other than the true
  // document root, `seam-editor-bin` is dead weight (the compile pass
  // only reads it from root) and an editing footgun (edits to the
  // nested copy diverge from the real bin and break self-healing).
  if (!isRoot && stripped.metadata?.[BIN_METADATA_KEY] != null) {
    const { [BIN_METADATA_KEY]: _bin, ...restMeta } = stripped.metadata;
    const hasOtherMeta = Object.keys(restMeta).length > 0;
    if (hasOtherMeta) {
      stripped = { ...stripped, metadata: restMeta };
    } else {
      const { metadata: _m, ...noMeta } = stripped;
      stripped = noMeta as Composition;
    }
  }

  // Recurse into `original` inside the script payload so its own
  // rendered bodies (if it's a script-driven or bin-referencing
  // composition itself) also disappear from view. The `original` is
  // never the root, so pass isRoot:false to drop any nested bin copy.
  if (
    hasScript &&
    typeof scriptPayload === "object" &&
    scriptPayload !== null &&
    "original" in (scriptPayload as Record<string, unknown>)
  ) {
    const payload = scriptPayload as { scriptSrc: string; original: unknown };
    const strippedOriginal = stripForJsonEditing(payload.original, {
      isRoot: false,
    });
    const newMeta = {
      ...(stripped.metadata ?? {}),
      [SCRIPT_METADATA_KEY]: { ...payload, original: strippedOriginal },
    };
    stripped = { ...stripped, metadata: newMeta };
  }

  // Recurse into children/attachments: a plain composition can contain
  // script/bin compositions that still need stripping. Children are
  // never the root.
  const recurseChild = (c: Child): Child =>
    c.type === "composition"
      ? (stripForJsonEditing(c, { isRoot: false }) as Composition)
      : c;

  const out: Composition = { ...stripped };
  if (stripped.children) out.children = stripped.children.map(recurseChild);
  if (stripped.attachments)
    out.attachments = stripped.attachments.map(recurseChild);
  return out;
}
