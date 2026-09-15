import { useEffect } from "react";
import { syncThemeMenu } from "./api/menu";
import { AppShell } from "./components/layout/AppShell";
import { useConnectionsStore } from "./store/connectionsStore";
import { selectResolvedTheme, useSettingsStore } from "./store/settingsStore";
import { toast } from "./store/toastStore";

export default function App() {
  const theme = useSettingsStore(selectResolvedTheme);
  const themePreference = useSettingsStore((s) => s.theme);
  const setSystemDark = useSettingsStore((s) => s.setSystemDark);
  const load = useConnectionsStore((s) => s.load);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    syncThemeMenu(themePreference).catch(() => undefined);
  }, [themePreference]);

  // Track the OS appearance: the "system" mode follows it live.
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
