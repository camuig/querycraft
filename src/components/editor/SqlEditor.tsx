import { useEffect, useRef } from "react";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  HighlightStyle,
  type LanguageSupport,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { sql, MySQL, type SQLNamespace } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { tags } from "@lezer/highlight";
import "../../styles/editor.css";

export type EditorTheme = "dark" | "light";

export interface SqlEditorProps {
  value: string;
  onChange: (v: string) => void;
  onExecute: (mode: "current" | "all") => void;
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

function buildLanguageExtension(schema: Record<string, string[]> | undefined, defaultTable: string | undefined): LanguageSupport {
  return sql({
    dialect: MySQL,
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

/** SQL-редактор на CodeMirror 6: подсветка, автокомплит по схеме, Mod-Enter/Mod-Shift-Enter. */
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

  // Создаём редактор один раз при монтировании.
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
        langCompartment.of(buildLanguageExtension(props.schema, props.defaultTable)),
        themeCompartment.of(buildThemeExtension(props.theme)),
        fontSizeCompartment.of(buildFontSizeExtension(props.fontSize)),
        readOnlyCompartment.of(EditorState.readOnly.of(!!props.readOnly)),
        execKeymap,
        keymap.of([...closeBracketsKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab, ...defaultKeymap]),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Синхронизация текста из props (без прыжков курсора — только если реально отличается).
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
      effects: langCompartment.reconfigure(buildLanguageExtension(props.schema, props.defaultTable)),
    });
  }, [props.schema, props.defaultTable, langCompartment]);

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
