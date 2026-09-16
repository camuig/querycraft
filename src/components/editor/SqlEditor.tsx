import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  deleteLine,
  history,
  historyKeymap,
  indentWithTab,
  moveLineDown,
  moveLineUp,
} from "@codemirror/commands";
import { type SQLNamespace, sql } from "@codemirror/lang-sql";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  type LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, Prec } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  crosshairCursor,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import type { DbKind } from "../../api/types";
import { duplicateLineOrSelection } from "./editorCommands";
import { editorDialect } from "./sqlDialects";
import "../../styles/editor.css";

export type EditorTheme = "dark" | "light";

export interface SqlEditorProps {
  value: string;
  onChange: (v: string) => void;
  onExecute: (mode: "current" | "all") => void;
  /** Engine of the connection — selects the SQL dialect for highlighting and completion. */
  kind: DbKind;
  schema?: Record<string, string[]>;
  defaultTable?: string;
  fontSize: number;
  theme: EditorTheme;
  readOnly?: boolean;
  editorRef?: React.MutableRefObject<EditorView | null>;
}

const MONO_FONT = '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const lightHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--keyword)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--number)" },
  { tag: [tags.lineComment, tags.blockComment], color: "var(--comment)", fontStyle: "italic" },
  { tag: tags.typeName, color: "var(--keyword)" },
  { tag: tags.operator, color: "var(--fg)" },
  { tag: tags.punctuation, color: "var(--fg-muted)" },
]);

const lightTheme = EditorView.theme(
  {
    "&": { color: "var(--fg)", backgroundColor: "var(--bg-editor)" },
    ".cm-content": { caretColor: "var(--fg)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--bg-selected)",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-panel-alt)",
      color: "var(--fg-dim)",
      border: "none",
      borderRight: "1px solid var(--border)",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "var(--bg-active)",
      outline: "1px solid var(--border-strong)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-tooltip)",
      border: "1px solid var(--border-strong)",
      color: "var(--fg)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--accent)",
      color: "var(--accent-fg)",
    },
    ".cm-selectionMatch": { backgroundColor: "var(--bg-hover)" },
  },
  { dark: false },
);

function buildThemeExtension(theme: EditorTheme): Extension {
  return theme === "dark" ? oneDark : [lightTheme, syntaxHighlighting(lightHighlightStyle)];
}

function buildLanguageExtension(
  kind: DbKind,
  schema: Record<string, string[]> | undefined,
  defaultTable: string | undefined,
): LanguageSupport {
  return sql({
    dialect: editorDialect(kind),
    schema: (schema ?? {}) as SQLNamespace,
    defaultTable,
    upperCaseKeywords: true,
  });
}

function buildFontSizeExtension(fontSize: number): Extension {
  return EditorView.theme({
    "&": { fontSize: `${fontSize}px` },
    ".cm-content, .cm-gutters": { fontFamily: MONO_FONT },
  });
}

/** SQL editor on CodeMirror 6: highlighting, schema-aware autocomplete, Mod-Enter / Mod-Shift-Enter. */
export function SqlEditor(props: SqlEditorProps) {
  const { onChange, onExecute } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onExecuteRef = useRef(onExecute);
  onChangeRef.current = onChange;
  onExecuteRef.current = onExecute;

  const langCompartment = useRef(new Compartment()).current;
  const themeCompartment = useRef(new Compartment()).current;
  const fontSizeCompartment = useRef(new Compartment()).current;
  const readOnlyCompartment = useRef(new Compartment()).current;

  // Create the editor once on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once, later prop changes go through compartments
  useEffect(() => {
    if (!containerRef.current) return;

    const execKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            onExecuteRef.current("current");
            return true;
          },
          preventDefault: true,
        },
        {
          key: "Mod-Shift-Enter",
          run: () => {
            onExecuteRef.current("all");
            return true;
          },
          preventDefault: true,
        },
        // DataGrip editing shortcuts. Mod-d replaces CodeMirror's "select next occurrence".
        { key: "Mod-d", run: duplicateLineOrSelection, preventDefault: true },
        { key: "Ctrl-y", mac: "Cmd-Backspace", run: deleteLine, preventDefault: true },
        { key: "Shift-Alt-ArrowUp", run: moveLineUp, preventDefault: true },
        { key: "Shift-Alt-ArrowDown", run: moveLineDown, preventDefault: true },
      ]),
    );

    const state = EditorState.create({
      doc: props.value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        bracketMatching(),
        closeBrackets(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        indentUnit.of("  "),
        autocompletion(),
        highlightSelectionMatches(),
        langCompartment.of(buildLanguageExtension(props.kind, props.schema, props.defaultTable)),
        themeCompartment.of(buildThemeExtension(props.theme)),
        fontSizeCompartment.of(buildFontSizeExtension(props.fontSize)),
        readOnlyCompartment.of(EditorState.readOnly.of(!!props.readOnly)),
        execKeymap,
        keymap.of([
          ...closeBracketsKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    if (props.editorRef) props.editorRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
      if (props.editorRef) props.editorRef.current = null;
    };
  }, []);

  // Sync text from props (without cursor jumps — only if it actually differs).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== props.value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
    }
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(buildThemeExtension(props.theme)) });
  }, [props.theme, themeCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: langCompartment.reconfigure(buildLanguageExtension(props.kind, props.schema, props.defaultTable)),
    });
  }, [props.kind, props.schema, props.defaultTable, langCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: fontSizeCompartment.reconfigure(buildFontSizeExtension(props.fontSize)) });
  }, [props.fontSize, fontSizeCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(!!props.readOnly)),
    });
  }, [props.readOnly, readOnlyCompartment]);

  return <div className="sql-editor" ref={containerRef} />;
}
