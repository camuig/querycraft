import { create } from "zustand";

/**
 * Status bar text slot for transient operation-result messages,
 * e.g. "500 rows in 12 ms". Rendered in StatusBar (src/components/layout/StatusBar.tsx).
 *
 * Usage from any component (editor, grid, etc.):
 *   import { useStatusStore } from "../../store/statusStore";
 *   useStatusStore.getState().setMessage("500 rows in 12 ms");
 * The message does not disappear on its own — the caller decides when to change/clear it
 * (by passing null), since only it knows when the context (active tab) has changed.
 */
interface StatusState {
  message: string | null;
  setMessage: (message: string | null) => void;
}

export const useStatusStore = create<StatusState>()((set) => ({
  message: null,
  setMessage: (message) => set({ message }),
}));
