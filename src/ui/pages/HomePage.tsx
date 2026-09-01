/** @jsxImportSource preact */
import type { JSX } from "preact";

export function HomePage(): JSX.Element {
  return (
    <div class="page">
      <h1 class="home-greeting">Good day 👋</h1>
      <div class="home-cards">
        <div class="home-card">
          <div class="home-card__title">This Month</div>
          <div class="home-card__value">—</div>
        </div>
        <div class="home-card">
          <div class="home-card__title">Deposits Maturing (30 days)</div>
          <div class="home-card__value">—</div>
        </div>
        <div class="home-card">
          <div class="home-card__title">Money by Bank</div>
          <div class="home-card__value">—</div>
        </div>
      </div>
    </div>
  );
}
