import { useEffect } from "preact/hooks";

/**
 * Minimal type for the Telegram Web App BackButton API.
 * Only the subset used in this hook is declared; full typing
 * would require a separate @types/telegram-web-app package.
 */
export interface TelegramBackButton {
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
}

interface TelegramWebApp {
  BackButton?: TelegramBackButton;
}

declare const Telegram: { WebApp: TelegramWebApp } | undefined;

/** Returns the Telegram BackButton if available in the current context. */
export function getTelegramBackButton(): TelegramBackButton | undefined {
  return typeof Telegram !== "undefined"
    ? Telegram.WebApp?.BackButton
    : undefined;
}

/**
 * Applies BackButton state to the given button object.
 * Returns a cleanup function that removes the handler and hides the button.
 *
 * Exported for unit testing; call sites should use useTelegramBackButton.
 */
export function applyBackButton(
  btn: TelegramBackButton,
  visible: boolean,
  onBack: () => void,
): () => void {
  if (visible) {
    btn.show();
    btn.onClick(onBack);
  } else {
    btn.hide();
  }
  return () => {
    btn.offClick(onBack);
    btn.hide();
  };
}

/**
 * Registers the Telegram Mini App BackButton.
 *
 * When `visible` is true the BackButton is shown and pressing it calls
 * `onBack`. When `visible` is false (i.e. the root/home screen) the
 * BackButton is hidden. Clean-up removes the listener on unmount or when
 * dependencies change so the app never navigates unexpectedly.
 */
export function useTelegramBackButton(visible: boolean, onBack: () => void): void {
  useEffect(() => {
    const btn = getTelegramBackButton();
    if (!btn) return;
    return applyBackButton(btn, visible, onBack);
  }, [visible, onBack]);
}
