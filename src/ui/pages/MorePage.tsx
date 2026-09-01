/** @jsxImportSource preact */
import type { JSX } from "preact";

export function MorePage(): JSX.Element {
  return (
    <div class="page placeholder-page">
      <div class="placeholder-page__icon" aria-hidden="true">
        ⚙️
      </div>
      <div class="placeholder-page__title">More</div>
      <div class="placeholder-page__subtitle">Settings, reports and account management.</div>
    </div>
  );
}
