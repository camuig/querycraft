import { useEffect } from "react";
import { AppShell } from "./components/layout/AppShell";
import { useSettingsStore } from "./store/settingsStore";
import { useConnectionsStore } from "./store/connectionsStore";
import { toast } from "./store/toastStore";

export default function App() {
  const theme = useSettingsStore((s) => s.theme);
  const load = useConnectionsStore((s) => s.load);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    load().catch(toast.error);
  }, [load]);

  return <AppShell />;
}
