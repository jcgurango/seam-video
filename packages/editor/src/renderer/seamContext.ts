import { createContext, useContext } from "react";
import type { Seam } from "@seam/core";

/** The host's Seam instance (core + installed extensions), provided by `App`
 *  from its `seam` prop. Pure-logic tools take the instance as their first
 *  argument instead; this is for components and hooks. */
export const SeamContext = createContext<Seam | null>(null);

export function useSeam(): Seam {
  const seam = useContext(SeamContext);
  if (!seam) throw new Error("useSeam: no Seam instance provided (wrap in <SeamContext.Provider>)");
  return seam;
}
