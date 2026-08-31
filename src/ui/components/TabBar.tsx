/** @jsxImportSource preact */
import type { JSX } from "preact";
import { TABS, type TabId } from "./tabs.js";

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function TabBar({ activeTab, onTabChange }: TabBarProps): JSX.Element {
  return (
    <nav class="tab-bar" role="navigation" aria-label="Main navigation">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          class={`tab-item${activeTab === tab.id ? " active" : ""}`}
          onClick={() => onTabChange(tab.id)}
          aria-label={tab.label}
          aria-current={activeTab === tab.id ? "page" : undefined}
          type="button"
        >
          <span class="tab-item__icon" aria-hidden="true">
            {tab.icon}
          </span>
          <span class="tab-item__label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
