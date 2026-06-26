import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { requireAuth, pagination, type AuthVars } from "../middleware.js";
import {
  deleteProject,
  fileResponse,
  projectPath,
  saveProject,
} from "../storage.js";
import { fingerprint } from "../media/fingerprint.js";
import type { Page, ProjectRecord } from "../types.js";

interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  size: number;
  contentHash: string | null;
  lastModified: number;
  createdAt: number;
  updatedAt: number;
}

const ORDER: Record<string, string> = {
  modified: "lastModified DESC",
  created: "createdAt DESC",
  name: "name COLLATE NOCASE ASC",
};

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  lastModified: z.number().optional(),
});

export const projectRoutes = new Hono<AuthVars>();
projectRoutes.use("*", requireAuth);

/** GET / — paginated, sortable list of the caller's projects. */
projectRoutes.get("/", (c) => {
  const userId = c.get("userId");
  const { page, pageSize } = pagination(c);
  const sort = c.req.query("sort") ?? "modified";
  const orderBy = ORDER[sort] ?? ORDER.modified;

  const total = (
    db
      .prepare("SELECT COUNT(*) AS c FROM project WHERE userId = ?")
      .get(userId) as { c: number }
  ).c;

  const rows = db
    .prepare(
      `SELECT * FROM project WHERE userId = ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    )
    .all(userId, pageSize, (page - 1) * pageSize) as ProjectRow[];

  const body: Page<ProjectRecord> = { items: rows, page, pageSize, total };
  return c.json(body);
});

/** Read a project document from a multipart body (`file`) or a raw JSON body. */
async function readUpload(
  c: Context<AuthVars>
): Promise<{ name: string; bytes: Buffer; lastModified: number } | null> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) return null;
    const name =
      (typeof body["name"] === "string" && body["name"]) || file.name || "untitled.seam";
    return {
      name,
      bytes: Buffer.from(await file.arrayBuffer()),
      lastModified: Number(body["lastModified"]) || Date.now(),
    };
  }
  // Raw body: name comes from the `?name=` query, content is the .seam bytes.
  const name = c.req.query("name");
  if (!name) return null;
  return {
    name,
    bytes: Buffer.from(await c.req.arrayBuffer()),
    lastModified: Date.now(),
  };
}

/**
 * POST / — create a NEW project. Projects dedup on filename only: a new
 * project may not reuse an existing project's name (the editor re-uploads an
 * already-synced project against its id via PUT, not here).
 */
projectRoutes.post("/", async (c) => {
  const userId = c.get("userId");
  const upload = await readUpload(c);
  if (!upload) return c.json({ error: "Missing project file or name" }, 400);

  const existing = db
    .prepare("SELECT * FROM project WHERE userId = ? AND name = ?")
    .get(userId, upload.name) as ProjectRow | undefined;
  if (existing) {
    return c.json(
      {
        error: "conflict",
        reason: "name-exists",
        message: `A project named "${upload.name}" already exists. Rename to upload as a new project.`,
        existing,
      },
      409
    );
  }

  const id = randomUUID();
  const now = Date.now();
  await saveProject(userId, id, upload.bytes);

  const row: ProjectRow = {
    id,
    userId,
    name: upload.name,
    size: upload.bytes.length,
    contentHash: fingerprint(upload.bytes),
    lastModified: upload.lastModified,
    createdAt: now,
    updatedAt: now,
  };
  try {
    db.prepare(
      `INSERT INTO project (id, userId, name, size, contentHash, lastModified, createdAt, updatedAt)
       VALUES (@id, @userId, @name, @size, @contentHash, @lastModified, @createdAt, @updatedAt)`
    ).run(row);
  } catch (err) {
    await deleteProject(userId, id);
    if (err instanceof Error && /UNIQUE constraint/.test(err.message)) {
      return c.json({ error: "conflict", reason: "name-exists" }, 409);
    }
    throw err;
  }

  return c.json(row, 201);
});

function findRow(userId: string, id: string): ProjectRow | undefined {
  return db
    .prepare("SELECT * FROM project WHERE id = ? AND userId = ?")
    .get(id, userId) as ProjectRow | undefined;
}

/** GET /:id — the metadata record. */
projectRoutes.get("/:id", (c) => {
  const row = findRow(c.get("userId"), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

/** GET /:id/file — stream the .seam document. */
projectRoutes.get("/:id/file", (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  const res = fileResponse(projectPath(userId, row.id), "application/json");
  return res ?? c.json({ error: "File missing" }, 404);
});

/** PUT /:id — replace the project's content (the sync write). */
projectRoutes.put("/:id", async (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);

  const upload = await readUpload(c);
  const bytes = upload?.bytes ?? Buffer.from(await c.req.arrayBuffer());
  await saveProject(userId, row.id, bytes);

  const now = Date.now();
  db.prepare(
    "UPDATE project SET size = ?, contentHash = ?, lastModified = ?, updatedAt = ? WHERE id = ? AND userId = ?"
  ).run(bytes.length, fingerprint(bytes), now, now, row.id, userId);

  return c.json(findRow(userId, row.id)!);
});

/** PATCH /:id — update metadata (rename). */
projectRoutes.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);

  let patch: z.infer<typeof patchSchema>;
  try {
    patch = patchSchema.parse(await c.req.json());
  } catch (err) {
    return c.json(
      { error: "Invalid body", detail: err instanceof Error ? err.message : err },
      400
    );
  }

  // Renaming onto another project's name would break filename uniqueness.
  if (patch.name && patch.name !== row.name) {
    const clash = db
      .prepare("SELECT id FROM project WHERE userId = ? AND name = ? AND id != ?")
      .get(userId, patch.name, row.id);
    if (clash) {
      return c.json(
        { error: "conflict", reason: "name-exists", message: `A project named "${patch.name}" already exists.` },
        409
      );
    }
  }

  db.prepare(
    "UPDATE project SET name = ?, lastModified = ?, updatedAt = ? WHERE id = ? AND userId = ?"
  ).run(
    patch.name ?? row.name,
    patch.lastModified ?? row.lastModified,
    Date.now(),
    row.id,
    userId
  );

  return c.json(findRow(userId, row.id)!);
});

/** DELETE /:id — remove the row and the on-disk document. */
projectRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const row = findRow(userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  db.prepare("DELETE FROM project WHERE id = ? AND userId = ?").run(row.id, userId);
  await deleteProject(userId, row.id);
  return c.json({ ok: true });
});
