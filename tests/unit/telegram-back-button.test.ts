/**
 * Tests for the Telegram BackButton integration logic.
 *
 * These tests verify the applyBackButton helper (exported for testing)
 * which contains the observable contract used by the useTelegramBackButton hook.
 * The hook itself relies on useEffect and requires a Preact rendering context;
 * the helper is tested directly to keep the suite environment-agnostic.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
  applyBackButton,
  type TelegramBackButton,
} from "../../src/ui/hooks/useTelegramBackButton.js";

function makeMockButton(): TelegramBackButton & {
  _shown: boolean;
  _handlers: Set<() => void>;
} {
  const handlers = new Set<() => void>();
  return {
    _shown: false,
    _handlers: handlers,
    show() {
      this._shown = true;
    },
    hide() {
      this._shown = false;
    },
    onClick(cb: () => void) {
      handlers.add(cb);
    },
    offClick(cb: () => void) {
      handlers.delete(cb);
    },
  };
}

describe("applyBackButton", () => {
  it("shows button and registers handler when visible=true", () => {
    const btn = makeMockButton();
    const onBack = () => {};
    applyBackButton(btn, true, onBack);
    assert.equal(btn._shown, true);
    assert.equal(btn._handlers.has(onBack), true);
  });

  it("hides button and does not register handler when visible=false", () => {
    const btn = makeMockButton();
    const onBack = () => {};
    applyBackButton(btn, false, onBack);
    assert.equal(btn._shown, false);
    assert.equal(btn._handlers.has(onBack), false);
  });

  it("cleanup removes handler and hides button", () => {
    const btn = makeMockButton();
    const onBack = () => {};
    const cleanup = applyBackButton(btn, true, onBack);
    assert.equal(btn._shown, true);
    cleanup();
    assert.equal(btn._shown, false);
    assert.equal(btn._handlers.has(onBack), false);
  });

  it("pressing BackButton calls the onBack callback", () => {
    const btn = makeMockButton();
    let called = false;
    const onBack = () => {
      called = true;
    };
    applyBackButton(btn, true, onBack);
    // Simulate Telegram invoking all registered handlers
    for (const h of btn._handlers) h();
    assert.equal(called, true);
  });

  it("cleanup after visible=false is a safe no-op (button already hidden)", () => {
    const btn = makeMockButton();
    const onBack = () => {};
    const cleanup = applyBackButton(btn, false, onBack);
    // Should not throw and button stays hidden
    assert.doesNotThrow(() => cleanup());
    assert.equal(btn._shown, false);
  });
});
