/** @jsxImportSource preact */
import type { JSX } from "preact";

export function ReceiptPage(): JSX.Element {
  return (
    <div class="page">
      <button class="receipt-primary-action" type="button" aria-label="Take receipt photo">
        <span class="receipt-primary-action__icon" aria-hidden="true">
          📷
        </span>
        <span>Take Receipt Photo</span>
      </button>
      <div class="placeholder-page">
        <div class="placeholder-page__title">Receipt capture</div>
        <div class="placeholder-page__subtitle">Photo upload and OCR review available in M3.</div>
      </div>
    </div>
  );
}
