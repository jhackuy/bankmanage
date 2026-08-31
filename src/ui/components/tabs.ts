/** Available navigation tabs in the Mini App. */
export type TabId = "home" | "receipt" | "deposits" | "transactions" | "more";

export interface TabDef {
  readonly id: TabId;
  readonly label: string;
  readonly icon: string;
}

export const TABS: readonly TabDef[] = [
  { id: "home", label: "Home", icon: "🏠" },
  { id: "receipt", label: "Receipt", icon: "📷" },
  { id: "deposits", label: "Deposits", icon: "🏦" },
  { id: "transactions", label: "Transactions", icon: "💳" },
  { id: "more", label: "More", icon: "⋯" },
] as const;
