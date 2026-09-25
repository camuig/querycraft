// CodeMirror 6 extension for inline AI completion ("ghost text"): after a typing pause, asks
// `source.request` for a completion and shows it as a dimmed, non-interactive widget right at the
// cursor. Tab accepts it, Escape or any further edit/selection change dismisses it. The extension
// itself only knows about CodeMirror state; `ConsoleTab` builds the `InlineCompletionSource` (the
// actual AI request) and `src/lib/ai/inline.ts` holds the pure trigger/prompt/cleanup logic.

import { completionStatus } from "@codemirror/autocomplete";
import { type Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { shouldTriggerInline } from "../../lib/ai/inline";

/** Debounce between the last doc change and the completion request. */
const DEBOUNCE_MS = 500;

export interface InlineCompletionSource {
  /** Resolves to the text to insert at the cursor, or "" for no suggestion. Rejects on abort. */
  request(prefix: string, suffix: string, signal: AbortSignal): Promise<string>;
}

interface Suggestion {
  /** Cursor position the suggestion was computed for; it is dropped as soon as the cursor moves. */
  pos: number;
  text: string;
}

const setSuggestion = StateEffect.define<Suggestion | null>();

class InlineSuggestionWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  override eq(other: InlineSuggestionWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-inline-suggestion";
    span.textContent = this.text;
    return span;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function decorationsFor(suggestion: Suggestion | null): DecorationSet {
  if (!suggestion?.text) return Decoration.none;
  const widget = Decoration.widget({ widget: new InlineSuggestionWidget(suggestion.text), side: 1 });
  return Decoration.set([widget.range(suggestion.pos)]);
}

/**
 * Holds the current suggestion (if any). A suggestion never survives a document change or a
 * selection change other than the one that introduced it, so positions never need remapping: it is
 * either exactly `setSuggestion`'s payload for this transaction, or cleared.
 */
const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestion)) return effect.value;
    }
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, decorationsFor),
});

class InlineCompletionPlugin implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly source: InlineCompletionSource,
  ) {}

  update(update: ViewUpdate): void {
    if (!update.docChanged && !update.selectionSet) return;
    this.cancelPending();
    if (update.docChanged) this.schedule();
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.maybeRequest(), DEBOUNCE_MS);
  }

  private cancelPending(): void {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
  }

  private maybeRequest(): void {
    const state = this.view.state;
    const sel = state.selection.main;
    if (!sel.empty) return;
    if (completionStatus(state) !== null) return;

    const pos = sel.head;
    const prefix = state.sliceDoc(0, pos);
    const suffix = state.sliceDoc(pos, state.doc.length);
    if (!shouldTriggerInline(prefix, suffix)) return;

    const controller = new AbortController();
    this.controller = controller;
    const requestedDoc = state.doc;

    this.source
      .request(prefix, suffix, controller.signal)
      .then((text) => {
        if (controller.signal.aborted || controller !== this.controller) return; // superseded
        const current = this.view.state;
        if (current.selection.main.head !== pos || !current.doc.eq(requestedDoc)) return; // stale
        if (!text) return;
        this.view.dispatch({ effects: setSuggestion.of({ pos, text }) });
      })
      .catch(() => undefined);
  }

  destroy(): void {
    this.cancelPending();
  }
}

function acceptSuggestion(view: EditorView): boolean {
  const suggestion = view.state.field(suggestionField, false);
  if (!suggestion?.text) return false;
  view.dispatch({
    changes: { from: suggestion.pos, to: suggestion.pos, insert: suggestion.text },
    selection: { anchor: suggestion.pos + suggestion.text.length },
    userEvent: "input.complete",
  });
  return true;
}

function dismissSuggestion(view: EditorView): boolean {
  const suggestion = view.state.field(suggestionField, false);
  if (!suggestion?.text) return false;
  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

const inlineCompletionKeymap = Prec.highest(
  keymap.of([
    { key: "Tab", run: acceptSuggestion },
    { key: "Escape", run: dismissSuggestion },
  ]),
);

const inlineCompletionTheme = EditorView.baseTheme({
  ".cm-inline-suggestion": {
    color: "var(--fg-dim)",
    whiteSpace: "pre",
  },
});

/** Builds the inline-completion extension for a `source`. Pass `null`/omit to disable the feature. */
export function inlineCompletion(source: InlineCompletionSource): Extension {
  return [
    suggestionField,
    ViewPlugin.define((view) => new InlineCompletionPlugin(view, source)),
    inlineCompletionKeymap,
    inlineCompletionTheme,
  ];
}
