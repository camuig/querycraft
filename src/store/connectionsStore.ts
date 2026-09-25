import { create } from "zustand";
import * as api from "../api/commands";
import type { AiAccess, ConnectionConfig, ConnectionInput, DbKind, ServerInfo } from "../api/types";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface ConnectionRuntime {
  status: ConnectionStatus;
  serverInfo: ServerInfo | null;
  error: string | null;
}

interface ConnectionsState {
  configs: ConnectionConfig[];
  runtime: Record<string, ConnectionRuntime>;
  loaded: boolean;
  /** Open edit dialog: null — closed, "new" — new connection, otherwise an id. */
  dialog: null | "new" | string;

  load: () => Promise<void>;
  save: (input: ConnectionInput) => Promise<ConnectionConfig>;
  remove: (id: string) => Promise<void>;
  connect: (id: string) => Promise<ServerInfo>;
  disconnect: (id: string) => Promise<void>;
  openDialog: (target: "new" | string) => void;
  closeDialog: () => void;
}

const idle: ConnectionRuntime = { status: "disconnected", serverInfo: null, error: null };

export const useConnectionsStore = create<ConnectionsState>()((set, get) => ({
  configs: [],
  runtime: {},
  loaded: false,
  dialog: null,

  load: async () => {
    const configs = await api.listConnections();
    set({ configs, loaded: true });
  },

  save: async (input) => {
    const saved = await api.saveConnection(input);
    set((s) => {
      const exists = s.configs.some((c) => c.id === saved.id);
      return {
        configs: exists ? s.configs.map((c) => (c.id === saved.id ? saved : c)) : [...s.configs, saved],
      };
    });
    return saved;
  },

  remove: async (id) => {
    if (get().runtime[id]?.status === "connected") {
      await api.disconnect(id).catch(() => undefined);
    }
    await api.deleteConnection(id);
    set((s) => {
      const runtime = { ...s.runtime };
      delete runtime[id];
      return { configs: s.configs.filter((c) => c.id !== id), runtime };
    });
  },

  connect: async (id) => {
    set((s) => ({ runtime: { ...s.runtime, [id]: { ...idle, status: "connecting" } } }));
    try {
      const serverInfo = await api.connect(id);
      set((s) => ({ runtime: { ...s.runtime, [id]: { status: "connected", serverInfo, error: null } } }));
      return serverInfo;
    } catch (e) {
      const error = String(e);
      set((s) => ({ runtime: { ...s.runtime, [id]: { status: "error", serverInfo: null, error } } }));
      throw e;
    }
  },

  disconnect: async (id) => {
    await api.disconnect(id);
    set((s) => ({ runtime: { ...s.runtime, [id]: idle } }));
  },

  openDialog: (target) => set({ dialog: target }),
  closeDialog: () => set({ dialog: null }),
}));

export function connectionStatus(id: string): ConnectionRuntime {
  return useConnectionsStore.getState().runtime[id] ?? idle;
}

/** Engine of a saved connection; falls back to MySQL for an unknown id so callers always get a dialect. */
export function selectConnectionKind(id: string) {
  return (s: ConnectionsState): DbKind => s.configs.find((c) => c.id === id)?.kind ?? "mysql";
}

/** How much a connection may share with the AI assistant; falls back to "off" for an unknown id. */
export function selectConnectionAiAccess(id: string) {
  return (s: ConnectionsState): AiAccess => s.configs.find((c) => c.id === id)?.aiAccess ?? "off";
}
