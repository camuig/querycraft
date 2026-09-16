import { create } from "zustand";
import { newId } from "../lib/ids";

export type ToastKind = "info" | "success" | "error";

/** Optional button shown inside a toast; the toast is dismissed after the click. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

export interface ToastOptions {
  /** Auto-dismiss delay; `0` keeps the toast until it is clicked. */
  ttlMs?: number;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (kind, message, { ttlMs = kind === "error" ? 8000 : 3500, action } = {}) => {
    const id = newId();
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, action }] }));
    if (ttlMs > 0) setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ttlMs);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (m: string, options?: ToastOptions) => useToastStore.getState().push("info", m, options),
  success: (m: string, options?: ToastOptions) => useToastStore.getState().push("success", m, options),
  error: (m: unknown, options?: ToastOptions) => useToastStore.getState().push("error", errorMessage(m), options),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
