// Registry of live CodeMirror EditorViews for open SQL/Redis consoles, keyed by tab id. Lets UI
// outside the tab tree (the AI chat panel's "Insert into console") reach a console's editor without
// prop-drilling it through the whole tab hierarchy. `ConsoleTab` registers its view while mounted.

import type { EditorView } from "@codemirror/view";

const views = new Map<string, EditorView>();

/** Registers `view` under `tabId`; returns the unregister function (use in a `useEffect` cleanup). */
export function registerConsoleEditor(tabId: string, view: EditorView): () => void {
  views.set(tabId, view);
  return () => {
    // Only clear the entry if it is still this exact view — a new one may already have replaced it.
    if (views.get(tabId) === view) views.delete(tabId);
  };
}

/** The live EditorView for a console tab, or undefined when that tab isn't mounted. */
export function getConsoleEditor(tabId: string): EditorView | undefined {
  return views.get(tabId);
}
