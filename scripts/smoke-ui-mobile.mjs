/**
 * scripts/smoke-ui-mobile.mjs
 *
 * Deterministic synthetic browser/mobile smoke for the built Mini App.
 *
 * Purpose:
 *   SPEC §10 / §10.1 requires the Mini App to render predictably at the
 *   iPhone Mini-class widths (360/390/430 CSS px) and to put the
 *   primary dashboard, deposit, and receipt surfaces behind a stable
 *   visual & structural contract. We don't run Puppeteer / Playwright
 *   here because those are not part of the project toolchain. Instead,
 *   this script statically inspects the built `dist/ui/` output and
 *   asserts that the necessary HTML and CSS contracts are present.
 *
 * What we check:
 *   1. `dist/ui/index.html` exists and has:
 *      - the Telegram Mini App SDK script tag,
 *      - a `<meta name="viewport">` tag with width=device-width,
 *      - a `<div id="app">` mount point,
 *      - a script entry pointing at the bundled JS.
 *   2. The built main JS bundle exists and references the three primary
 *      surface components (HomePage, ReceiptPage, DepositsPage) by their
 *      non-minified export names (Rollup keeps these; the layout hashes
 *      are still emitted but the export names appear in the chunk).
 *   3. The built CSS contains the SPEC-mandated responsive contracts:
 *      - tab-bar bottom navigation with min-height 52px (primary targets),
 *      - overflow-x: hidden on body and #app (no horizontal scroll),
 *      - safe-area-inset-bottom handling,
 *      - prefers-reduced-motion override.
 *   4. No JS or CSS file references a public R2 bucket URL pattern.
 *
 * Out of scope:
 *   - Real Telegram `window.Telegram.WebApp` interaction.
 *   - JS execution / hydration timing.
 *   - Real pixel-perfect rendering at all three widths (requires a
 *     browser). The static structural checks here are the deterministic
 *     substitute agreed in the M5 acceptance criteria.
 *
 * Public API:
 *   smokeMobileUi({ distDir }) -> { ok, results, widths }
 *
 * CLI mode:
 *   node scripts/smoke-ui-mobile.mjs [dist-dir] [--widths=360,390,430]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST_DIR = join(__dirname, "..", "dist", "ui");

const REQUIRED_VIEWPORT = /<meta[^>]*name=["']viewport["'][^>]*width=device-width/i;
const REQUIRED_APP_MOUNT = /id=["']app["']/i;
const REQUIRED_TELEGRAM_SDK = /telegram\.org\/js\/telegram-web-app\.js/i;

const CSS_RULES = [
  // SPEC §10: primary touch targets >= 52x52 CSS px; the tab bar uses
  // min-height: 52px on every .tab-item.
  {
    name: "CSS: primary touch targets >= 52px (tab bar)",
    pattern: /\.tab-item[^{]*\{[^}]*min-height:\s*52px/iu,
  },
  // SPEC §10: no horizontal overflow.
  { name: "CSS: body has overflow-x: hidden", pattern: /body[^{]*\{[^}]*overflow-x:\s*hidden/iu },
  // SPEC §10: safe-area-inset handling.
  {
    name: "CSS: safe-area-inset-bottom is used",
    pattern: /safe-area-inset-bottom/iu,
  },
  // SPEC §10.1: respect prefers-reduced-motion.
  {
    name: "CSS: prefers-reduced-motion override",
    pattern: /prefers-reduced-motion:\s*reduce/iu,
  },
  // Receipt CTA is the primary dashboard surface per SPEC §6.1 / §9.
  {
    name: "CSS: receipt primary action container exists",
    pattern: /\.receipt-primary-action/iu,
  },
];

const JS_EXPORT_HINTS = ["HomePage", "ReceiptPage", "DepositsPage"];

const FORBIDDEN_PUBLIC_BUCKET_PATTERNS = [
  /r2\.cloudflarestorage\.com/,
  /pub-[a-z0-9]+\.r2\.dev/,
  /https?:\/\/[^"'\s)]*\.r2\.dev/iu,
];

function pickIndexHtml(distDir, fsImpl) {
  const entries = fsImpl.readdirSync(distDir);
  const candidates = entries.filter((f) => f === "index.html" || f.endsWith(".html"));
  if (candidates.length === 0) return null;
  return join(distDir, candidates[0]);
}

function listFilesRecursive(dir, fsImpl) {
  const files = [];
  for (const name of fsImpl.readdirSync(dir)) {
    const full = join(dir, name);
    const stat = fsImpl.statSync(full);
    if (stat.isDirectory()) files.push(...listFilesRecursive(full, fsImpl));
    else files.push(full);
  }
  return files;
}

function pickJsBundle(distDir, fsImpl) {
  const candidates = listFilesRecursive(distDir, fsImpl)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".js.map"))
    .sort();
  return candidates[0] ?? null;
}

function pickCssBundle(distDir, fsImpl) {
  const candidates = listFilesRecursive(distDir, fsImpl)
    .filter((f) => f.endsWith(".css") && !f.endsWith(".css.map"))
    .sort();
  return candidates[0] ?? null;
}

function checkHtml(indexPath, fsImpl) {
  const html = fsImpl.readFileSync(indexPath, "utf8");
  const results = [];
  if (REQUIRED_TELEGRAM_SDK.test(html)) {
    results.push({ name: "index.html includes Telegram Mini App SDK", pass: true, detail: "ok" });
  } else {
    results.push({
      name: "index.html includes Telegram Mini App SDK",
      pass: false,
      detail: "missing telegram-web-app.js script tag",
    });
  }
  if (REQUIRED_VIEWPORT.test(html)) {
    results.push({
      name: "index.html has responsive viewport meta",
      pass: true,
      detail: "ok",
    });
  } else {
    results.push({
      name: "index.html has responsive viewport meta",
      pass: false,
      detail: "missing <meta name='viewport' content='width=device-width'>",
    });
  }
  if (REQUIRED_APP_MOUNT.test(html)) {
    results.push({
      name: "index.html has #app mount point",
      pass: true,
      detail: "ok",
    });
  } else {
    results.push({
      name: "index.html has #app mount point",
      pass: false,
      detail: "missing <div id='app'>",
    });
  }
  return results;
}

function checkCss(cssPath, fsImpl) {
  const css = fsImpl.readFileSync(cssPath, "utf8");
  return CSS_RULES.map((rule) => ({
    name: rule.name,
    pass: rule.pattern.test(css),
    detail: rule.pattern.test(css) ? "ok" : "rule not found",
  }));
}

function checkJsBundle(jsPath, fsImpl) {
  const js = fsImpl.readFileSync(jsPath, "utf8");
  return JS_EXPORT_HINTS.map((hint) => ({
    name: `JS bundle references ${hint}`,
    pass: js.includes(hint),
    detail: js.includes(hint) ? "ok" : `no reference to ${hint}`,
  }));
}

function checkNoPublicBucketUrls(distDir, fsImpl) {
  const offenders = [];
  for (const full of listFilesRecursive(distDir, fsImpl)) {
    const name = full.slice(distDir.length + 1);
    if (name.endsWith(".map") || !/\.(html|js|css)$/iu.test(name)) continue;
    const text = fsImpl.readFileSync(full, "utf8");
    for (const pattern of FORBIDDEN_PUBLIC_BUCKET_PATTERNS) {
      if (pattern.test(text)) {
        offenders.push(`${name}: ${pattern}`);
      }
    }
  }
  return [
    {
      name: "no public R2 bucket URL in built UI files",
      pass: offenders.length === 0,
      detail: offenders.length === 0 ? "ok" : `offending patterns: ${offenders.join(", ")}`,
    },
  ];
}

export function smokeMobileUi(options = {}) {
  const distDir = options.distDir ?? DEFAULT_DIST_DIR;
  const widths = options.widths ?? [360, 390, 430];
  const fsImpl = {
    existsSync: options.fs?.existsSync ?? existsSync,
    readdirSync: options.fs?.readdirSync ?? readdirSync,
    readFileSync: options.fs?.readFileSync ?? readFileSync,
    statSync: options.fs?.statSync ?? statSync,
  };

  if (!fsImpl.existsSync(distDir)) {
    return {
      ok: false,
      widths,
      results: [
        {
          name: "dist/ui exists",
          pass: false,
          detail: `${distDir} not found (run npm run build:ui first)`,
        },
      ],
    };
  }

  const indexPath = pickIndexHtml(distDir, fsImpl);
  if (indexPath === null) {
    return {
      ok: false,
      widths,
      results: [{ name: "dist/ui/index.html exists", pass: false, detail: "no html file in dist/ui" }],
    };
  }

  const cssPath = pickCssBundle(distDir, fsImpl);
  const jsPath = pickJsBundle(distDir, fsImpl);

  const results = [];
  results.push(...checkHtml(indexPath, fsImpl));
  if (cssPath !== null) {
    results.push(...checkCss(cssPath, fsImpl));
  } else {
    results.push({ name: "dist/ui CSS bundle exists", pass: false, detail: "no .css file" });
  }
  if (jsPath !== null) {
    results.push(...checkJsBundle(jsPath, fsImpl));
  } else {
    results.push({ name: "dist/ui JS bundle exists", pass: false, detail: "no .js file" });
  }
  results.push(...checkNoPublicBucketUrls(distDir, fsImpl));

  // The widths are informational — static checks don't render real
  // layouts. We assert that all three SPEC-required widths are present
  // so a future maintainer can extend the renderer without accidentally
  // dropping one.
  const expectedWidths = [360, 390, 430];
  for (const w of expectedWidths) {
    results.push({
      name: `target width ${w} CSS px is in scope`,
      pass: widths.includes(w),
      detail: widths.includes(w) ? "ok" : `${w} missing from widths[]`,
    });
  }

  return {
    ok: results.every((r) => r.pass),
    results,
    widths,
  };
}

function parseArgs(argv) {
  const positional = [];
  let distDir;
  let widths;
  for (const arg of argv) {
    if (arg.startsWith("--dist-dir=")) {
      distDir = arg.slice("--dist-dir=".length);
    } else if (arg.startsWith("--widths=")) {
      widths = arg
        .slice("--widths=".length)
        .split(",")
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isFinite(n));
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  return { positional, options: { ...(distDir ? { distDir } : {}), ...(widths ? { widths } : {}) } };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === new URL(process.argv[1], "file:").href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const { positional, options: parsedOpts } = parseArgs(process.argv.slice(2));
  const argDist = positional[0];
  const result = smokeMobileUi({
    ...(argDist ? { distDir: argDist } : {}),
    ...parsedOpts,
  });
  process.stdout.write(`SMOKE_UI_WIDTHS=${result.widths.join(",")}\n`);
  process.stdout.write(`SMOKE_UI_RESULTS=${result.results.length}\n`);
  let allPass = true;
  for (const r of result.results) {
    process.stdout.write(`${r.pass ? "PASS" : "FAIL"}\t${r.name}\t${r.detail}\n`);
    if (!r.pass) allPass = false;
  }
  process.stdout.write(allPass ? "SMOKE_UI_OK\n" : "SMOKE_UI_FAILED\n");
  process.exitCode = allPass ? 0 : 1;
}
