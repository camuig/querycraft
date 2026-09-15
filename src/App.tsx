import { useEffect } from "react";
import { AppShell } from "./components/layout/AppShell";
import { selectResolvedTheme, useSettingsStore } from "./store/settingsStore";
import { useConnectionsStore } from "./store/connectionsStore";
import { toast } from "./store/toastStore";

export default function App() {
  const theme = useSettingsStore(selectResolvedTheme);
  const setSystemDark = useSettingsStore((s) => s.setSystemDark);
  const load = useConnectionsStore((s) => s.load);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Следим за системной темой: режим "system" переключается вслед за ОС.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [setSystemDark]);

  useEffect(() => {
    load().catch(toast.error);
  }, [load]);

  return <AppShell />;
}
