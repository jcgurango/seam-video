import type { SeamExtension } from "../registry.js";

/** A stand-in extension for core's own tests: a `stage` node type that is a
 *  container (children placed in node-local time) with one required field,
 *  the shape the real Map extension has. Core never names a real extension. */
export const stage: SeamExtension = {
  name: "stage",
  nodes: [
    {
      type: "stage",
      children: true,
      draws: true,
      fields: [
        { key: "source", type: "string", required: true, source: true },
        { key: "level", type: "number", min: 0, max: 10, default: 1, animatable: true },
        { key: "mode", type: "enum", options: ["a", "b"], default: "a" },
        { key: "tint", type: "color" },
        { key: "gap", type: "length" },
        // A structured value: validated by a schema built with core's Zod.
        {
          key: "points",
          type: "custom",
          schema: (z) => z.array(z.tuple([z.number(), z.number()])).min(2),
        },
      ],
    },
  ],
};
