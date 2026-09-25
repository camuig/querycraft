/**
 * Application keymap modelled after DataGrip defaults.
 *
 * Every action lists its shortcuts per platform. Shortcuts are matched by
 * `KeyboardEvent.code` (physical key) rather than `key`, because on macOS the
 * Option modifier changes the produced character (Option+N gives "˜").
 */

export type AppAction =
  | "executeStatement"
  | "executeScript"
  | "cancelQuery"
  | "newConsole"
  | "newConnection"
  | "refresh"
  | "submitChanges"
  | "revertChanges"
  | "addRow"
  | "deleteRow"
  | "setNull"
  | "nextPage"
  | "prevPage"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "focusExplorer"
  | "openTableData"
  | "goToDdl"
  | "openSettings"
  | "checkForUpdates"
  | "aiGenerate"
  | "aiExplain"
  | "aiOptimize"
  | "toggleAiChat";

export type Platform = "mac" | "other";

export interface Shortcut {
  /** `KeyboardEvent.code`, e.g. "KeyR", "Enter", "F5", "ArrowDown". */
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

interface ActionSpec {
  label: string;
  mac: Shortcut[];
  other: Shortcut[];
}

function sc(code: string, mods: Omit<Shortcut, "code"> = {}): Shortcut {
  return { code, ...mods };
}

/** Actions in the order they are matched; shared shortcuts are resolved by the command bus. */
export const KEYMAP: Record<AppAction, ActionSpec> = {
  executeStatement: { label: "Execute", mac: [sc("Enter", { meta: true })], other: [sc("Enter", { ctrl: true })] },
  executeScript: {
    label: "Execute script",
    mac: [sc("Enter", { meta: true, shift: true })],
    other: [sc("Enter", { ctrl: true, shift: true })],
  },
  cancelQuery: { label: "Cancel running query", mac: [sc("F2", { meta: true })], other: [sc("F2", { ctrl: true })] },
  newConsole: {
    label: "New query console",
    mac: [sc("KeyQ", { ctrl: true, shift: true }), sc("KeyN", { meta: true, shift: true })],
    other: [sc("KeyQ", { ctrl: true, shift: true }), sc("KeyN", { ctrl: true, shift: true })],
  },
  newConnection: { label: "New connection", mac: [], other: [] },
  refresh: { label: "Refresh", mac: [sc("KeyR", { meta: true })], other: [sc("F5", { ctrl: true })] },
  submitChanges: { label: "Submit changes", mac: [sc("Enter", { meta: true })], other: [sc("Enter", { ctrl: true })] },
  revertChanges: {
    label: "Revert changes",
    mac: [sc("KeyZ", { meta: true, alt: true })],
    other: [sc("KeyZ", { ctrl: true, alt: true })],
  },
  addRow: { label: "Add row", mac: [sc("KeyN", { meta: true })], other: [sc("Insert", { alt: true })] },
  deleteRow: { label: "Delete row", mac: [sc("Backspace", { meta: true })], other: [sc("KeyY", { ctrl: true })] },
  setNull: {
    label: "Set NULL",
    mac: [sc("KeyN", { meta: true, alt: true })],
    other: [sc("KeyN", { ctrl: true, alt: true })],
  },
  nextPage: {
    label: "Next page",
    mac: [sc("ArrowDown", { meta: true, alt: true })],
    other: [sc("ArrowDown", { ctrl: true, alt: true })],
  },
  prevPage: {
    label: "Previous page",
    mac: [sc("ArrowUp", { meta: true, alt: true })],
    other: [sc("ArrowUp", { ctrl: true, alt: true })],
  },
  closeTab: { label: "Close tab", mac: [sc("KeyW", { meta: true })], other: [sc("F4", { ctrl: true })] },
  nextTab: {
    label: "Next tab",
    mac: [sc("BracketRight", { meta: true, shift: true })],
    other: [sc("ArrowRight", { alt: true })],
  },
  prevTab: {
    label: "Previous tab",
    mac: [sc("BracketLeft", { meta: true, shift: true })],
    other: [sc("ArrowLeft", { alt: true })],
  },
  focusExplorer: {
    label: "Database explorer",
    mac: [sc("Digit1", { meta: true })],
    other: [sc("Digit1", { alt: true })],
  },
  openTableData: { label: "Open table data", mac: [sc("F4")], other: [sc("F4")] },
  goToDdl: { label: "Go to DDL", mac: [sc("KeyB", { meta: true })], other: [sc("KeyB", { ctrl: true })] },
  openSettings: {
    label: "Settings",
    mac: [sc("Comma", { meta: true })],
    other: [sc("KeyS", { ctrl: true, alt: true })],
  },
  checkForUpdates: { label: "Check for updates", mac: [], other: [] },
  aiGenerate: {
    label: "Generate SQL with AI",
    mac: [sc("Backslash", { meta: true })],
    other: [sc("Backslash", { ctrl: true })],
  },
  // DataGrip has no default shortcut for either action.
  aiExplain: { label: "Explain query", mac: [], other: [] },
  aiOptimize: { label: "Optimize query", mac: [], other: [] },
  toggleAiChat: {
    label: "AI chat",
    mac: [sc("KeyI", { meta: true, shift: true })],
    other: [sc("KeyI", { ctrl: true, shift: true })],
  },
};

/**
 * Extra shortcuts that apply only while the data grid has the focus: plain keys that would be
 * unsafe application-wide (Backspace in the explorer must not delete table rows). The grid
 * resolves them together with KEYMAP; the global handler never sees them.
 */
export const GRID_KEYMAP: Partial<Record<AppAction, Shortcut[]>> = {
  deleteRow: [sc("Delete"), sc("Backspace")],
};

export function detectPlatform(
  nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator,
): Platform {
  const s = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /Mac|iPhone|iPad/i.test(s) ? "mac" : "other";
}

/** The subset of `KeyboardEvent` needed for matching (keeps tests free of DOM). */
export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function matchesShortcut(e: KeyLike, s: Shortcut): boolean {
  return (
    e.code === s.code &&
    e.metaKey === !!s.meta &&
    e.ctrlKey === !!s.ctrl &&
    e.altKey === !!s.alt &&
    e.shiftKey === !!s.shift
  );
}

/** All actions bound to the pressed key combination, in keymap order. */
export function actionsForEvent(e: KeyLike, platform: Platform): AppAction[] {
  const result: AppAction[] = [];
  for (const action of Object.keys(KEYMAP) as AppAction[]) {
    if (KEYMAP[action][platform].some((s) => matchesShortcut(e, s))) result.push(action);
  }
  return result;
}

/** Actions for a key pressed inside the data grid: KEYMAP matches plus the grid-only shortcuts. */
export function gridActionsForEvent(e: KeyLike, platform: Platform): AppAction[] {
  const result = actionsForEvent(e, platform);
  for (const action of Object.keys(GRID_KEYMAP) as AppAction[]) {
    if (!result.includes(action) && GRID_KEYMAP[action]?.some((s) => matchesShortcut(e, s))) result.push(action);
  }
  return result;
}

export function shortcutsOf(action: AppAction, platform: Platform): Shortcut[] {
  return KEYMAP[action][platform];
}

/** Actions sharing at least one shortcut with `action` (including itself), in keymap order. */
export function actionsSharingShortcut(action: AppAction, platform: Platform): AppAction[] {
  const own = KEYMAP[action][platform];
  return (Object.keys(KEYMAP) as AppAction[]).filter((a) =>
    KEYMAP[a][platform].some((s) => own.some((o) => sameShortcut(s, o))),
  );
}

function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return (
    a.code === b.code &&
    !!a.meta === !!b.meta &&
    !!a.ctrl === !!b.ctrl &&
    !!a.alt === !!b.alt &&
    !!a.shift === !!b.shift
  );
}

const CODE_LABELS: Record<string, string> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Insert: "Insert",
  Comma: ",",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const MAC_CODE_LABELS: Record<string, string> = { ...CODE_LABELS, Enter: "⏎", Backspace: "⌫" };

function codeLabel(code: string, platform: Platform): string {
  const table = platform === "mac" ? MAC_CODE_LABELS : CODE_LABELS;
  if (table[code]) return table[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

/** Human readable shortcut: "⌘⇧⏎" on macOS, "Ctrl+Shift+Enter" elsewhere. */
export function formatShortcut(s: Shortcut, platform: Platform): string {
  if (platform === "mac") {
    return `${s.ctrl ? "⌃" : ""}${s.alt ? "⌥" : ""}${s.shift ? "⇧" : ""}${s.meta ? "⌘" : ""}${codeLabel(s.code, platform)}`;
  }
  const parts: string[] = [];
  if (s.ctrl) parts.push("Ctrl");
  if (s.alt) parts.push("Alt");
  if (s.shift) parts.push("Shift");
  if (s.meta) parts.push("Win");
  parts.push(codeLabel(s.code, platform));
  return parts.join("+");
}

/** Primary shortcut of an action for tooltips, or "" when it has none. */
export function shortcutLabel(action: AppAction, platform: Platform = detectPlatform()): string {
  const first = KEYMAP[action][platform][0];
  return first ? formatShortcut(first, platform) : "";
}

/** "Label (shortcut)" for button tooltips. */
export function actionTitle(
  action: AppAction,
  label = KEYMAP[action].label,
  platform: Platform = detectPlatform(),
): string {
  const key = shortcutLabel(action, platform);
  return key ? `${label} (${key})` : label;
}
