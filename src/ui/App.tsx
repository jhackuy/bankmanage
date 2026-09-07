/** @jsxImportSource preact */
import { useCallback, useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { TabBar } from "./components/TabBar.js";
import type { TabId } from "./components/tabs.js";
import { HomePage } from "./pages/HomePage.js";
import { ReceiptPage } from "./pages/ReceiptPage.js";
import { DepositsPage } from "./pages/DepositsPage.js";
import { TransactionsPage } from "./pages/TransactionsPage.js";
import { MorePage } from "./pages/MorePage.js";
import { useTelegramBackButton } from "./hooks/useTelegramBackButton.js";
import {
  bootstrapAuth,
  browserMiniAppAuthTransport,
  browserRawInitDataSource,
  type BootstrapIdentity,
} from "./bootstrap-auth.js";

function renderPage(tab: TabId): JSX.Element {
  switch (tab) {
    case "home":
      return <HomePage />;
    case "receipt":
      return <ReceiptPage />;
    case "deposits":
      return <DepositsPage />;
    case "transactions":
      return <TransactionsPage />;
    case "more":
      return <MorePage />;
  }
}

type AuthState =
  | { readonly status: "pending" }
  | { readonly status: "authenticated"; readonly identity: BootstrapIdentity }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * Fail-closed screen shown when the Mini App bootstrap auth did not
 * succeed. The message is intentionally short and never echoes the raw
 * initData, server error bodies, or bot token.
 */
function UnauthorizedScreen({ message }: { readonly message: string }): JSX.Element {
  return (
    <div class="placeholder-page" role="alert" aria-live="polite">
      <div class="placeholder-page__icon" aria-hidden="true">
        🔒
      </div>
      <div class="placeholder-page__title">Unavailable</div>
      <div class="placeholder-page__subtitle">{message}</div>
    </div>
  );
}

function LoadingScreen(): JSX.Element {
  return (
    <div class="placeholder-page" role="status" aria-live="polite">
      <div class="placeholder-page__icon" aria-hidden="true">
        ⏳
      </div>
      <div class="placeholder-page__title">Verifying…</div>
    </div>
  );
}

export function App(): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>("home");
  const [auth, setAuth] = useState<AuthState>({ status: "pending" });

  // Show the Telegram BackButton on any non-home tab; tapping it returns to Home.
  const handleBack = useCallback(() => setActiveTab("home"), []);
  useTelegramBackButton(activeTab !== "home", handleBack);

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      const result = await bootstrapAuth({
        rawInitDataSource: browserRawInitDataSource(),
        transport: browserMiniAppAuthTransport(),
      });
      if (cancelled) return;
      if (result.ok) {
        setAuth({ status: "authenticated", identity: result.identity });
      } else {
        setAuth({ status: "unavailable", message: result.message });
      }
    })().catch(() => {
      if (cancelled) return;
      setAuth({
        status: "unavailable",
        message: "Could not reach the authentication service.",
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (auth.status === "pending") {
    return <LoadingScreen />;
  }
  if (auth.status === "unavailable") {
    return <UnauthorizedScreen message={auth.message} />;
  }

  return (
    <div class="app-shell">
      <main class="main-content" role="main">
        {renderPage(activeTab)}
      </main>
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}
