/**
 * tests/unit/smoke-ui-mobile.test.ts
 *
 * Verifies the M5 deterministic synthetic browser/mobile smoke:
 *   - passes against a handcrafted dist/ui directory that satisfies
 *     every SPEC contract;
 *   - fails when the viewport meta is missing;
 *   - fails when the #app mount point is missing;
 *   - fails when the Telegram Mini App SDK script tag is missing;
 *   - fails when each SPEC-mandated CSS rule is absent;
 *   - fails when a JS bundle omits a primary surface export name;
 *   - fails when a public R2 bucket URL leaks into any built file;
 *   - reports missing dist/ui/ up front;
 *   - asserts that 360/390/430 are all in-scope widths.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { smokeMobileUi } from "../../scripts/smoke-ui-mobile.mjs";

function makeFakeDistDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "m5-ui-smoke-"));
  return dir;
}

function writeConformingUi(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta charset="UTF-8">
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/assets/index-abc123.js"></script>
  </body>
</html>
`
  );
  writeFileSync(
    join(dir, "assets/index-abc123.js"),
    "const HomePage=()=>'home';const ReceiptPage=()=>'r';const DepositsPage=()=>'d';export{HomePage,ReceiptPage,DepositsPage};"
  );
  writeFileSync(
    join(dir, "assets/index-abc123.css"),
    `
.tab-item { min-height: 52px; min-width: 52px; }
body { overflow-x: hidden; padding-bottom: env(safe-area-inset-bottom, 0px); }
@media (prefers-reduced-motion: reduce) { * { transition-duration: 0.01ms !important; } }
.receipt-primary-action { width: 100%; }
`
  );
  writeFileSync(join(dir, ".placeholder"), "ignore me");
}

interface DistOverrides {
  html?: string;
  css?: string;
  js?: string;
  cssName?: string;
  jsName?: string;
  extraFiles?: Record<string, string>;
}

function writeCustomUi(dir: string, overrides: DistOverrides, removeExisting = false): void {
  if (removeExisting) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
  if (overrides.html !== undefined) writeFileSync(join(dir, "index.html"), overrides.html);
  if (overrides.css !== undefined) {
    writeFileSync(join(dir, overrides.cssName ?? "assets/index.css"), overrides.css);
  }
  if (overrides.js !== undefined) {
    writeFileSync(join(dir, overrides.jsName ?? "assets/index.js"), overrides.js);
  }
  if (overrides.extraFiles) {
    for (const [name, body] of Object.entries(overrides.extraFiles)) {
      writeFileSync(join(dir, name), body);
    }
  }
}

describe("smokeMobileUi — conforming dist", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFakeDistDir();
    writeConformingUi(dir);
  });

  it("passes every check against the conforming dist", () => {
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(true);
    for (const r of result.results) {
      expect(r.pass, `${r.name}: ${r.detail}`).toBe(true);
    }
    expect(result.widths).toEqual(expect.arrayContaining([360, 390, 430]));
  });

  it("reports missing dist/ui when the directory does not exist", () => {
    const result = smokeMobileUi({ distDir: join(dir, "does-not-exist") });
    expect(result.ok).toBe(false);
    expect(result.results[0]?.name).toBe("dist/ui exists");
  });
});

describe("smokeMobileUi — HTML contract", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFakeDistDir();
    writeConformingUi(dir);
  });

  it("fails when the viewport meta is missing", () => {
    const html = "<!doctype html><html><head></head><body><div id='app'></div></body></html>";
    writeCustomUi(
      dir,
      { html, js: "export const HomePage=1;export const ReceiptPage=1;export const DepositsPage=1;" },
      true
    );
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    expect(result.results.find((r) => r.name === "index.html has responsive viewport meta")?.pass).toBe(
      false
    );
  });

  it("fails when the #app mount is missing", () => {
    writeCustomUi(
      dir,
      {
        html: "<!doctype html><html><head><meta name='viewport' content='width=device-width'></head><body></body></html>",
        js: "export const HomePage=1;export const ReceiptPage=1;export const DepositsPage=1;",
      },
      true
    );
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    expect(result.results.find((r) => r.name === "index.html has #app mount point")?.pass).toBe(false);
  });

  it("fails when the Telegram Mini App SDK is missing", () => {
    writeCustomUi(
      dir,
      {
        html: "<!doctype html><html><head><meta name='viewport' content='width=device-width'></head><body><div id='app'></div></body></html>",
        js: "export const HomePage=1;export const ReceiptPage=1;export const DepositsPage=1;",
      },
      true
    );
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    expect(result.results.find((r) => r.name === "index.html includes Telegram Mini App SDK")?.pass).toBe(
      false
    );
  });
});

describe("smokeMobileUi — CSS contract", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFakeDistDir();
  });

  it("fails when the tab bar 52px min-height rule is absent", () => {
    writeCustomUi(dir, {
      html: "<!doctype html><meta name='viewport' content='width=device-width'><div id='app'></div><script src='https://telegram.org/js/telegram-web-app.js'></script>",
      js: "export const HomePage=1;export const ReceiptPage=1;export const DepositsPage=1;",
      css: ".tab-item{color:red}body{overflow-x:hidden}@media (prefers-reduced-motion: reduce){*{transition:none}}.receipt-primary-action{}",
    });
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    const check = result.results.find((r) => r.name === "CSS: primary touch targets >= 52px (tab bar)");
    expect(check?.pass).toBe(false);
  });

  it("fails when overflow-x: hidden on body is absent", () => {
    writeCustomUi(dir, {
      html: "<!doctype html><meta name='viewport' content='width=device-width'><div id='app'></div><script src='https://telegram.org/js/telegram-web-app.js'></script>",
      js: "export const HomePage=1;export const ReceiptPage=1;export const DepositsPage=1;",
      css: ".tab-item{min-height:52px}body{}.safe-area-inset-bottom{}@media (prefers-reduced-motion: reduce){*{transition:none}}",
    });
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    const check = result.results.find((r) => r.name === "CSS: body has overflow-x: hidden");
    expect(check?.pass).toBe(false);
  });

  it("fails when safe-area-inset-bottom is absent", () => {
    writeCustomUi(dir, {
      html: "<!doctype html><meta name='viewport' content='width=device-width'><div id='app'></div><script src='https://telegram.org/js/telegram-web-app.js'></script>",
      js: "export const HomePage=1;export const ReceiptPage=1;export const DepositsPage=1;",
      css: ".tab-item{min-height:52px}body{overflow-x:hidden}@media (prefers-reduced-motion: reduce){*{transition:none}}.receipt-primary-action{}",
    });
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    const check = result.results.find((r) => r.name === "CSS: safe-area-inset-bottom is used");
    expect(check?.pass).toBe(false);
  });

  it("fails when prefers-reduced-motion is absent", () => {
    writeCustomUi(dir, {
      html: "<!doctype html><meta name='viewport' content='width=device-width'><div id='app'></div><script src='https://telegram.org/js/telegram-web-app.js'></script>",
      js: "export const HomePage=1;export const ReceiptPage=1;export const DepositsPage=1;",
      css: ".tab-item{min-height:52px}body{overflow-x:hidden}safe-area-inset-bottom{}",
    });
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    const check = result.results.find((r) => r.name === "CSS: prefers-reduced-motion override");
    expect(check?.pass).toBe(false);
  });

  it("fails when receipt primary action class is absent", () => {
    writeCustomUi(dir, {
      html: "<!doctype html><meta name='viewport' content='width=device-width'><div id='app'></div><script src='https://telegram.org/js/telegram-web-app.js'></script>",
      js: "export const HomePage=1;export const ReceiptPage=1;export const DepositsPage=1;",
      css: ".tab-item{min-height:52px}body{overflow-x:hidden}safe-area-inset-bottom{}@media (prefers-reduced-motion: reduce){*{transition:none}}",
    });
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    const check = result.results.find((r) => r.name === "CSS: receipt primary action container exists");
    expect(check?.pass).toBe(false);
  });
});

describe("smokeMobileUi — JS bundle contract", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFakeDistDir();
  });

  it("fails when a primary surface export is missing from the JS bundle", () => {
    writeCustomUi(dir, {
      html: "<!doctype html><meta name='viewport' content='width=device-width'><div id='app'></div><script src='https://telegram.org/js/telegram-web-app.js'></script>",
      js: "export const HomePage=1;",
      css: ".tab-item{min-height:52px}body{overflow-x:hidden}safe-area-inset-bottom{}@media (prefers-reduced-motion: reduce){*{transition:none}}.receipt-primary-action{}",
    });
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    const check = result.results.find((r) => r.name === "JS bundle references DepositsPage");
    expect(check?.pass).toBe(false);
  });
});

describe("smokeMobileUi — privacy guard", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFakeDistDir();
  });

  it("fails when a public R2 bucket URL is embedded in built HTML", () => {
    writeCustomUi(dir, {
      html: "<!doctype html><meta name='viewport' content='width=device-width'><a href='https://pub-abc.r2.dev/x'>x</a><div id='app'></div><script src='https://telegram.org/js/telegram-web-app.js'></script>",
      js: "export const HomePage=1;export const ReceiptPage=1;export const DepositsPage=1;",
      css: ".tab-item{min-height:52px}body{overflow-x:hidden}safe-area-inset-bottom{}@media (prefers-reduced-motion: reduce){*{transition:none}}.receipt-primary-action{}",
    });
    const result = smokeMobileUi({ distDir: dir });
    expect(result.ok).toBe(false);
    const check = result.results.find((r) => r.name === "no public R2 bucket URL in built UI files");
    expect(check?.pass).toBe(false);
  });
});

describe("smokeMobileUi — widths coverage", () => {
  it("asserts all three SPEC widths are in scope by default", () => {
    const dir = makeFakeDistDir();
    writeConformingUi(dir);
    const result = smokeMobileUi({ distDir: dir });
    expect(result.widths).toEqual(expect.arrayContaining([360, 390, 430]));
  });

  it("allows a custom width list but reports a missing width as a failed check", () => {
    const dir = makeFakeDistDir();
    writeConformingUi(dir);
    const result = smokeMobileUi({ distDir: dir, widths: [360] });
    expect(result.ok).toBe(false);
    const missing390 = result.results.find((r) => r.name === "target width 390 CSS px is in scope");
    const missing430 = result.results.find((r) => r.name === "target width 430 CSS px is in scope");
    expect(missing390?.pass).toBe(false);
    expect(missing430?.pass).toBe(false);
  });
});
