import { create } from "zustand";

/**
 * Текстовый слот статус-бара для мимолётных сообщений о результате операции,
 * например "500 строк за 12 мс". Рендерится в StatusBar (src/components/layout/StatusBar.tsx).
 *
 * Использование из любого компонента (редактор, грид и т.д.):
 *   import { useStatusStore } from "../../store/statusStore";
 *   useStatusStore.getState().setMessage("500 строк за 12 мс");
 * Сообщение не исчезает само — вызывающий код сам решает, когда его сменить/очистить
 * (передав null), т.к. только он знает, когда контекст (активная вкладка) сменился.
 */
interface StatusState {
  message: string | null;
  setMessage: (message: string | null) => void;
}

export const useStatusStore = create<StatusState>()((set) => ({
  message: null,
  setMessage: (message) => set({ message }),
}));
