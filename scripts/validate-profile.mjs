#!/usr/bin/env node
/**
 * Profile README validator.
 *
 * Guards the things that silently break a GitHub profile: a renamed asset, a
 * placeholder URL that shipped as a real link, an SVG that reaches out to the
 * network, or an image with no alt text. Node built-ins only, no dependencies.
 *
 * Usage: node scripts/validate-profile.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, posix } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');

const failures = [];
const notes = [];

const fail = (check, detail) => failures.push(`${check}: ${detail}`);
const note = (line) => notes.push(line);

/** Strip HTML comments so commented-out drafts are never treated as shipped content. */
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

/** Decode as strict UTF-8 so mojibake and stray control bytes are caught, not rendered. */
function readStrictUtf8(path) {
  const bytes = readFileSync(path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const byte of bytes) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      throw new Error(`control byte 0x${byte.toString(16).padStart(2, '0')} in file`);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------

if (!existsSync(README)) {
  fail('readme-exists', 'README.md not found at repository root');
  report();
}

let readme;
try {
  readme = readStrictUtf8(README);
} catch (err) {
  fail('readme-encoding', `README.md is not clean UTF-8 (${err.message})`);
  report();
}

const live = stripComments(readme);

// --- 1. Required sections --------------------------------------------------

const REQUIRED_SECTIONS = [
  '⚔️ About',
  '🗡️ Skills',
  '🏛️ Projects',
  '📜 Philosophy',
  '🦅 Contact',
];

const headings = [...live.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);
for (const section of REQUIRED_SECTIONS) {
  if (!headings.includes(section)) {
    fail('required-sections', `missing "## ${section}"`);
  }
}

const duplicates = headings.filter((h, i) => headings.indexOf(h) !== i);
if (duplicates.length) {
  fail('duplicate-sections', `repeated heading(s): ${[...new Set(duplicates)].join(', ')}`);
}

// --- 2. Local asset references resolve -------------------------------------

const assetRefs = new Set();
for (const m of live.matchAll(/(?:src|srcset)="([^"]+)"/g)) assetRefs.add(m[1]);
for (const m of live.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) assetRefs.add(m[1]);

const localAssets = [...assetRefs].filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith('data:'));

if (localAssets.length === 0) {
  fail('local-assets', 'README references no local assets; expected the banner, hero, and journey images');
}

for (const ref of localAssets) {
  const onDisk = join(ROOT, ...ref.split(posix.sep));
  if (!existsSync(onDisk) || !statSync(onDisk).isFile()) {
    fail('local-assets', `referenced file does not exist: ${ref}`);
  }
}

// --- 3. Theme variants and banner present ----------------------------------

for (const required of [
  'assets/banner.png',
  'assets/hero-light.svg',
  'assets/hero-dark.svg',
  'assets/journey-light.svg',
  'assets/journey-dark.svg',
]) {
  if (!existsSync(join(ROOT, ...required.split('/')))) {
    fail('theme-assets', `missing ${required}`);
  } else if (!assetRefs.has(required)) {
    fail('theme-assets', `${required} exists but is not referenced by README.md`);
  }
}

// --- 4. Every <picture> offers a dark source and a light fallback -----------

const pictures = [...live.matchAll(/<picture>([\s\S]*?)<\/picture>/g)].map((m) => m[1]);
if (pictures.length === 0) fail('theme-switching', 'no <picture> element found');
for (const [i, block] of pictures.entries()) {
  if (!/prefers-color-scheme:\s*dark/.test(block)) {
    fail('theme-switching', `<picture> #${i + 1} has no dark-scheme <source>`);
  }
  if (!/<img\s/.test(block)) {
    fail('theme-switching', `<picture> #${i + 1} has no <img> fallback`);
  }
}

// --- 5. Images carry meaningful alt text -----------------------------------

for (const m of live.matchAll(/<img\s[^>]*>/g)) {
  const tag = m[0];
  const alt = tag.match(/\salt="([^"]*)"/);
  if (!alt) fail('alt-text', `<img> without an alt attribute: ${tag.slice(0, 70)}...`);
  else if (alt[1].trim().length < 15) {
    fail('alt-text', `alt text too short to be useful: "${alt[1]}"`);
  }
}

// --- 6. No placeholder ever ships as a live link ---------------------------

const PLACEHOLDER = /\b(MOCK_[A-Z0-9_]+|PROJECT_NAME|PROJECT_URL|DEMO_URL|SHORT_DESCRIPTION|PROBLEM_STATEMENT|LINKEDIN_URL|YOUTUBE_URL|TODO_[A-Z0-9_]+)\b/;

for (const m of live.matchAll(/(?:href|src|srcset)="([^"]*)"/g)) {
  if (PLACEHOLDER.test(m[1])) {
    fail('placeholders', `placeholder shipped as a live link target: ${m[1]}`);
  }
}
for (const m of live.matchAll(/\]\(([^)\s]+)\)/g)) {
  if (PLACEHOLDER.test(m[1])) {
    fail('placeholders', `placeholder shipped as a live markdown link: ${m[1]}`);
  }
}

const pending = [...readme.matchAll(new RegExp(PLACEHOLDER.source, 'g'))].map((m) => m[0]);
if (pending.length) {
  note(`${new Set(pending).size} placeholder(s) parked in comments: ${[...new Set(pending)].join(', ')}`);
}

// --- 7. No public repositories featured ------------------------------------

const FORBIDDEN_REPOS = ['next-tinacms', 'typescript-course'];
for (const repo of FORBIDDEN_REPOS) {
  if (new RegExp(`\\b${repo}\\b`, 'i').test(live)) {
    fail('no-featured-repos', `README mentions the repository "${repo}"`);
  }
}
if (/^##\s+Featured Projects/im.test(live)) {
  fail('no-featured-repos', 'a "Featured Projects" section is present');
}

// --- 8. No external image or stats services --------------------------------

const BANNED_HOSTS = [
  'github-readme-stats',
  'streak-stats',
  'github-profile-trophy',
  'github-readme-activity-graph',
  'github-profile-summary-cards',
  'skillicons.dev',
  'capsule-render',
  'readme-typing-svg',
  'ghchart.rshah.org',
  'komarev.com',
  'visitor-badge',
  'img.shields.io',
];

for (const ref of assetRefs) {
  for (const host of BANNED_HOSTS) {
    if (ref.includes(host)) fail('no-external-images', `${host} referenced by ${ref}`);
  }
  if (/^https?:\/\//.test(ref)) {
    fail('no-external-images', `remote image dependency: ${ref}`);
  }
}

// --- 9. Local SVGs are self-contained and well-formed ----------------------

for (const ref of localAssets.filter((r) => r.endsWith('.svg'))) {
  const onDisk = join(ROOT, ...ref.split(posix.sep));
  if (!existsSync(onDisk)) continue;

  let svg;
  try {
    svg = readStrictUtf8(onDisk);
  } catch (err) {
    fail('svg-encoding', `${ref} is not clean UTF-8 (${err.message})`);
    continue;
  }

  if (!/<svg[\s>]/.test(svg) || !/<\/svg>\s*$/.test(svg.trim())) {
    fail('svg-structure', `${ref} does not open and close a root <svg> element`);
  }
  if (!/\bviewBox="/.test(svg)) {
    fail('svg-structure', `${ref} has no viewBox, so it will not scale responsively`);
  }
  if (/<script/i.test(svg)) fail('svg-safety', `${ref} contains <script>`);
  if (/https?:\/\//.test(svg.replace(/xmlns(:\w+)?="[^"]*"/g, ''))) {
    fail('svg-safety', `${ref} references a remote URL`);
  }
  if (/@import|<style/i.test(svg)) fail('svg-safety', `${ref} uses <style> or @import`);
  if (!/<title[\s>]/.test(svg)) fail('svg-a11y', `${ref} has no <title> element`);

  // Every url(#id) must resolve to an id defined in the same document.
  const definedIds = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) {
    if (!definedIds.has(m[1])) fail('svg-structure', `${ref} references undefined id "#${m[1]}"`);
  }

  const bytes = statSync(onDisk).size;
  if (bytes > 60_000) fail('svg-weight', `${ref} is ${bytes} bytes; keep profile assets small`);
}

// --- 10. No email address exposed ------------------------------------------

const email = live.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
if (email) fail('no-email', `email address exposed in README: ${email[0]}`);

// --- 10b. No unresolved merge conflict markers -----------------------------

if (/^<<<<<<<|^=======|^>>>>>>>/m.test(live)) {
  fail('no-conflict-markers', 'README still contains unresolved merge conflict markers');
}

// --- 11. Balanced block-level HTML -----------------------------------------

for (const tag of ['div', 'table', 'tr', 'td', 'picture', 'details', 'summary']) {
  const open = (live.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (live.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  if (open !== close) fail('html-balance', `<${tag}>: ${open} opening vs ${close} closing tags`);
}

// --- 12. Founder context stays secondary to the engineering identity -------

const BRAND = /jahat/i;

const firstHeading = live.search(/^##\s+/m);
const hero = firstHeading === -1 ? live : live.slice(0, firstHeading);
if (BRAND.test(hero)) {
  fail('founder-context', 'Jahat Digital appears above the first section; the hero stays engineering-first');
}

const brandSections = live
  .split(/^##\s+/m)
  .slice(1)
  .filter((block) => BRAND.test(block))
  .map((block) => block.split('\n')[0].trim());

if (brandSections.length > 2) {
  fail(
    'founder-context',
    `Jahat Digital appears in ${brandSections.length} sections, max is 2: ${brandSections.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------

report();

function report() {
  for (const line of notes) console.log(`note     ${line}`);

  if (failures.length === 0) {
    console.log(`\nprofile validation passed (${REQUIRED_SECTIONS.length} sections, ${localAssets?.length ?? 0} local assets)`);
    process.exit(0);
  }

  console.error(`\n${failures.length} problem(s) found:\n`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
