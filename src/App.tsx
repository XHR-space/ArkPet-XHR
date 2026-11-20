import { AppShell } from "./components/AppShell";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { StateProvider } from "./state";

export function App() {
  return (
    <StateProvider>
      <ConfirmProvider>
        <AppShell />
      </ConfirmProvider>
    </StateProvider>
  );
}
