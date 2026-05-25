// Shared keyboard-shortcut guards: skip global hotkeys when the user is
// typing into any editable surface so editor inputs (Monaco's JSON /
// Script editors, the Bin rename input, etc.) keep their natural
// behaviour. Monaco in particular forwards keystrokes through a hidden
// `<textarea class="inputarea">` nested under elements whose class
// includes `monaco-editor` / `inputarea`, and depending on the path
// `e.target` isn't always that textarea (composition events, re-
// dispatched keys, etc.) — so we check `document.activeElement` first
// (most reliable: it's the element actually receiving input) and walk
// up from `e.target` as a backup.

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // Monaco's overlay container holds the hidden textarea + a few
  // contenteditable surfaces; any keydown originating inside it should
  // be treated as "user is typing into the editor".
  if ((el as Element).closest?.(".monaco-editor")) return true;
  return false;
}

/** Returns true when a global keybinding should bail out — i.e., the
 *  user is currently typing into an editable surface. */
export function isTypingInEditableSurface(e: KeyboardEvent): boolean {
  if (isEditableElement(document.activeElement)) return true;
  const target = e.target as Element | null;
  if (isEditableElement(target)) return true;
  return false;
}
