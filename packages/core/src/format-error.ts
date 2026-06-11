import { z } from "zod";

/** A validation problem with its location in the document, ready to render. */
export interface FormattedIssue {
  /** Dotted/bracketed location, e.g. `children[0].out` ("" for the root). */
  path: string;
  message: string;
}

/** The discriminant key our object unions (Child, graphic objects, filters)
 *  switch on. */
const TYPE_KEY = "type";

/** How many alternative-form descriptions to list before truncating, so a
 *  deeply-nested union failure can't produce a wall of text. */
const MAX_EXPECTED = 8;

/**
 * Turn a Zod error into a flat list of human-readable issues.
 *
 * The reason this exists: our schema is built from recursive `z.union`s
 * (`ChildSchema`, the graphic-object union, `Length`/`Point2D`/`keyframed`,
 * text, padding). When a `z.union` fails, Zod surfaces a single top-level
 * issue whose message is the famously unhelpful `"Invalid input"` — every
 * branch's real complaint is buried in `issue.unionErrors`. Mapping over
 * `error.issues` directly therefore collapses any malformed node to
 * `children.0: Invalid input`.
 *
 * This walker descends into union errors and, for each one, decides which
 * branch the author *meant*:
 *   - For type-discriminated unions (Child, graphic objects) it drops every
 *     branch that only failed because its `type` literal didn't match, so a
 *     bad clip reports the clip's real errors rather than seven sibling
 *     "expected literal 'audio'" complaints.
 *   - For structural unions (number | string | tuple …) it drops branches the
 *     value isn't even shaped like, then reports the closest remaining one.
 *   - If nothing matches, it synthesizes an "expected one of …" message from
 *     the candidate literals / types.
 *
 * Note: every issue inside a `z.union`'s `unionErrors` carries an absolute
 * path from the document root (not relative to the branch), so this walker
 * uses `issue.path` verbatim and compares depths against the union's own path.
 */
export function formatZodError(error: z.ZodError): string[] {
  const issues: FormattedIssue[] = [];
  collect(error, issues);
  // Two different branches can surface the same problem; dedupe on the
  // rendered string so we don't repeat ourselves.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const issue of issues) {
    const line = issue.path ? `${issue.path}: ${issue.message}` : issue.message;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  // A failed parse should never produce an empty error list.
  if (out.length === 0) out.push("Invalid document");
  return out;
}

type Path = (string | number)[];

function collect(error: z.ZodError, issues: FormattedIssue[]): void {
  for (const issue of error.issues) {
    if (issue.code === "invalid_union") {
      collectUnion(issue.unionErrors, issue.path, issues);
    } else {
      issues.push({ path: pathToString(issue.path), message: issue.message });
    }
  }
}

function collectUnion(
  unionErrors: z.ZodError[],
  unionPath: Path,
  issues: FormattedIssue[]
): void {
  // Branches the value isn't even the right kind for — wrong `type` literal,
  // or wrong primitive shape entirely. These are "you picked the wrong union
  // member", not "your data is subtly wrong", so they're noise.
  const candidates = unionErrors.filter(
    (e) =>
      !isDiscriminantMismatch(e, unionPath) && !isShapeMismatch(e, unionPath)
  );

  if (candidates.length === 1) {
    collect(candidates[0], issues);
    return;
  }

  if (candidates.length > 1) {
    // A structural union (e.g. Length, Point2D) where the value plausibly
    // fits more than one branch. Report the closest match — the branch that
    // got furthest before failing (fewest leftover problems).
    let best = candidates[0];
    let bestCount = countIssues(best);
    for (const e of candidates.slice(1)) {
      const c = countIssues(e);
      if (c < bestCount) {
        best = e;
        bestCount = c;
      }
    }
    collect(best, issues);
    return;
  }

  // Nothing matched: synthesize an "expected one of …" from what the branches
  // were each looking for.
  const literals = expectedLiterals(unionErrors, unionPath);
  if (literals.length > 0) {
    issues.push({
      path: pathToString([...unionPath, TYPE_KEY]),
      message: `Invalid type. Expected one of: ${truncateList(literals)}`,
    });
    return;
  }
  const shapes = expectedShapes(unionErrors, unionPath);
  if (shapes.length > 0) {
    issues.push({
      path: pathToString(unionPath),
      message: `Expected ${truncateList(shapes, " or ")}`,
    });
    return;
  }
  // No structured signal — fall back to the branches' own messages so we
  // still say *something* concrete.
  const messages = unionErrors.flatMap((e) => e.issues.map((i) => i.message));
  issues.push({
    path: pathToString(unionPath),
    message: `Did not match any allowed form: ${truncateList(
      [...new Set(messages)],
      " | "
    )}`,
  });
}

/** Does `issue` sit at `unionPath + [key]` (a direct field of the branch)? */
function isFieldOf(issue: z.ZodIssue, unionPath: Path, key: string): boolean {
  return (
    issue.path.length === unionPath.length + 1 &&
    issue.path[unionPath.length] === key &&
    samePrefix(issue.path, unionPath)
  );
}

/** Does `issue` sit exactly at the branch root (the union's own position)? */
function isAtRoot(issue: z.ZodIssue, unionPath: Path): boolean {
  return issue.path.length === unionPath.length && samePrefix(issue.path, unionPath);
}

function samePrefix(path: Path, prefix: Path): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

/** A branch that failed only because its `type` discriminant didn't match. */
function isDiscriminantMismatch(error: z.ZodError, unionPath: Path): boolean {
  return error.issues.some(
    (i) =>
      isFieldOf(i, unionPath, TYPE_KEY) &&
      (i.code === "invalid_literal" ||
        i.code === "invalid_type" ||
        i.code === "invalid_union_discriminator")
  );
}

/** A branch the value isn't even the right kind for (e.g. a number where this
 *  branch wanted an array). Every issue is an `invalid_type` at the branch
 *  root — the value never got past "wrong shape". */
function isShapeMismatch(error: z.ZodError, unionPath: Path): boolean {
  return (
    error.issues.length > 0 &&
    error.issues.every(
      (i) => isAtRoot(i, unionPath) && i.code === "invalid_type"
    )
  );
}

/** Count the issues a branch would ultimately surface (recursing unions), so
 *  we can pick the closest-matching branch of a structural union. */
function countIssues(error: z.ZodError): number {
  const sink: FormattedIssue[] = [];
  collect(error, sink);
  return sink.length;
}

/** Literal `type` values the branches accept — for discriminated unions. */
function expectedLiterals(unionErrors: z.ZodError[], unionPath: Path): string[] {
  const out: string[] = [];
  for (const e of unionErrors) {
    for (const i of e.issues) {
      if (isFieldOf(i, unionPath, TYPE_KEY) && i.code === "invalid_literal") {
        out.push(String(i.expected));
      } else if (i.code === "invalid_union_discriminator") {
        for (const opt of i.options) out.push(String(opt));
      }
    }
  }
  return [...new Set(out)];
}

/** Primitive kinds the branches accept — for structural unions. */
function expectedShapes(unionErrors: z.ZodError[], unionPath: Path): string[] {
  const out: string[] = [];
  for (const e of unionErrors) {
    for (const i of e.issues) {
      if (isAtRoot(i, unionPath) && i.code === "invalid_type") {
        out.push(String(i.expected));
      }
    }
  }
  return [...new Set(out)];
}

function truncateList(items: string[], sep = ", "): string {
  if (items.length <= MAX_EXPECTED) return items.join(sep);
  return items.slice(0, MAX_EXPECTED).join(sep) + `${sep}…`;
}

/** `["children", 0, "out"]` → `"children[0].out"`. Root path → `""`. */
function pathToString(path: Path): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (out === "") out = seg;
    else out += `.${seg}`;
  }
  return out;
}
