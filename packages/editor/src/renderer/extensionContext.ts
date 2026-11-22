import { createContext, useContext } from "react";
import type { EditorExtension, EditorStorage } from "@seam/core";

/** What the installed editor extensions add, for components deep in the tree
 *  (the Properties panel), provided by `App`. */
export interface EditorExtensionsValue {
  extensions: readonly EditorExtension[];
  /** The persistent store of the extension named `name` (kept in the
   *  editor's settings). */
  storage(name: string): EditorStorage;
}

const EMPTY: EditorExtensionsValue = {
  extensions: [],
  storage: () => ({ get: () => undefined, set: () => {} }),
};

export const EditorExtensionsContext = createContext<EditorExtensionsValue>(EMPTY);

export const useEditorExtensions = (): EditorExtensionsValue => useContext(EditorExtensionsContext);
