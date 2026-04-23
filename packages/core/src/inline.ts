import type {
  Child,
  Clip,
  Composition,
  Empty,
  Filter,
  ObjectFit,
  Overflow,
  Position,
  RefChild,
  TimeAnchor,
  Underflow,
} from "./types.js";

/**
 * Recursively inline `ref` children by substituting their definitions. Returns
 * an equivalent tree containing no `ref` nodes and no `refs` dicts.
 *
 * Semantics:
 * - A ref looks up its name in the enclosing scope chain (nearest composition's
 *   `refs` dict first, then outward). Shallowest wins.
 * - The ref's own timing/spatial/filter fields window the *resolved duration*
 *   of the definition. To express that uniformly across def types, we wrap
 *   the inlined def in a 1-child composition carrying those fields.
 * - Nested refs inside a definition resolve using the scope the def was
 *   *authored* in (the chain starting from the composition whose `refs`
 *   contains the name), not the scope at the ref's usage site. Otherwise a
 *   deeper composition could shadow a name the def expected to resolve
 *   higher up.
 * - Cycle detection: track the set of ref names currently being expanded.
 */
export function inlineRefs<T extends Composition>(root: T): T {
  return inlineNode(root, [], new Set<string>()) as T;
}

type Scope = Record<string, Child>;

function inlineNode(
  node: Child,
  stack: Scope[],
  active: Set<string>
): Child {
  switch (node.type) {
    case "clip":
    case "empty":
      return node;

    case "ref":
      return inlineRef(node, stack, active);

    case "composition": {
      const newStack: Scope[] = node.refs ? [node.refs, ...stack] : stack;
      const newChildren = node.children.map((c) =>
        inlineNode(c, newStack, active)
      );
      const newAttachments = node.attachments
        ? node.attachments.map((c) => inlineNode(c, newStack, active))
        : undefined;
      // Strip `refs` from the output — after inlining there's nothing left
      // to reference them.
      const { refs: _refs, ...rest } = node;
      void _refs;
      const result: Composition = { ...rest, children: newChildren };
      if (newAttachments) {
        result.attachments = newAttachments;
      }
      return result;
    }
  }
}

function lookupRef(
  name: string,
  stack: Scope[]
): { def: Child; index: number } | null {
  for (let i = 0; i < stack.length; i++) {
    const scope = stack[i];
    if (Object.prototype.hasOwnProperty.call(scope, name)) {
      return { def: scope[name], index: i };
    }
  }
  return null;
}

function inlineRef(
  ref: RefChild,
  stack: Scope[],
  active: Set<string>
): Child {
  const found = lookupRef(ref.source, stack);
  if (!found) {
    throw new Error(
      `ref "${ref.source}" is not defined in any enclosing scope`
    );
  }
  if (active.has(ref.source)) {
    throw new Error(`ref "${ref.source}" forms a cycle`);
  }

  // The def's authoring scope is the suffix of the stack starting where it
  // was found. Nested refs inside the def resolve against that, not against
  // any deeper compositions above the usage site.
  const defScope = stack.slice(found.index);

  active.add(ref.source);
  let inlinedDef: Child;
  try {
    inlinedDef = inlineNode(found.def, defScope, active);
  } finally {
    active.delete(ref.source);
  }

  return wrapWithRefFields(inlinedDef, ref);
}

interface RefFields {
  in?: number;
  out?: number;
  flex?: number;
  overflow?: Overflow;
  underflow?: Underflow;
  filters?: Filter[];
  position?: Position;
  objectFit?: ObjectFit;
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  width?: string;
  height?: string;
  id?: string;
  start?: TimeAnchor;
  end?: TimeAnchor;
}

function wrapWithRefFields(def: Child, ref: RefFields): Composition {
  return {
    type: "composition",
    children: [def as Clip | Empty | Composition],
    ...(ref.in != null ? { in: ref.in } : {}),
    ...(ref.out != null ? { out: ref.out } : {}),
    ...(ref.flex != null ? { flex: ref.flex } : {}),
    ...(ref.overflow != null ? { overflow: ref.overflow } : {}),
    ...(ref.underflow != null ? { underflow: ref.underflow } : {}),
    ...(ref.filters ? { filters: ref.filters } : {}),
    ...(ref.position != null ? { position: ref.position } : {}),
    ...(ref.objectFit != null ? { objectFit: ref.objectFit } : {}),
    ...(ref.top != null ? { top: ref.top } : {}),
    ...(ref.left != null ? { left: ref.left } : {}),
    ...(ref.right != null ? { right: ref.right } : {}),
    ...(ref.bottom != null ? { bottom: ref.bottom } : {}),
    ...(ref.width != null ? { width: ref.width } : {}),
    ...(ref.height != null ? { height: ref.height } : {}),
    ...(ref.id != null ? { id: ref.id } : {}),
    ...(ref.start != null ? { start: ref.start } : {}),
    ...(ref.end != null ? { end: ref.end } : {}),
  };
}
