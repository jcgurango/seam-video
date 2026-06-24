import { betterAuth } from "better-auth";
import { db } from "./db.js";
import { env } from "./env.js";

/**
 * better-auth instance. Email/password only (no social providers yet) — Seam
 * Cloud accounts are provisioned by the admin, not self-signup.
 *
 * The `role` field (ADMIN | USER) is added to the user table via
 * `additionalFields`. `input: false` keeps it out of the public signup body so
 * a caller can't grant itself ADMIN; the admin role is set directly in the DB
 * by the bootstrap pass (see bootstrap.ts).
 */
export const auth = betterAuth({
  database: db,
  baseURL: env.baseURL,
  secret: env.authSecret,
  basePath: "/api/auth",
  trustedOrigins: [env.baseURL, "http://localhost:5173"],
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "USER",
        input: false,
      },
    },
  },
});

export type Role = "ADMIN" | "USER";
