/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { TabBar } from "./components/TabBar.js";
import type { TabId } from "./components/tabs.js";
import { HomePage } from "./pages/HomePage.js";
import { ReceiptPage } from "./pages/ReceiptPage.js";
import { DepositsPage } from "./pages/DepositsPage.js";
import { TransactionsPage } from "./pages/TransactionsPage.js";
import { MorePage } from "./pages/MorePage.js";

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

export function App(): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>("home");

  return (
    <div id="app">
      <main class="main-content" role="main">
        {renderPage(activeTab)}
      </main>
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}
