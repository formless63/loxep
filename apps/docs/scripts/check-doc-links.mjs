#!/usr/bin/env node
/**
 * Offline internal-link checker for the built docs site.
 *
 * Resolves every internal href exactly as a browser would (WHATWG URL
 * semantics against the page URL, including the deploy base path) and fails
 * when the target page does not exist in dist/. This intentionally catches
 * wrong-level relative links that file-relative validators consider valid.
 *
 * Usage: node scripts/check-doc-links.mjs [distDir] [basePath]
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const distDir = process.argv[2] ?? join(import.meta.dirname, '..', 'dist');
const base = (process.argv[3] ?? '/loxep/').replace(/\/?$/, '/');
const origin = 'https://internal.invalid';

if (!existsSync(distDir)) {
  console.error(`dist directory not found: ${distDir} — build the docs first`);
  process.exit(2);
}

const htmlFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith('.html')) htmlFiles.push(full);
  }
})(distDir);

// Every URL path that serves content, normalized to trailing-slash form.
const served = new Set();
for (const file of htmlFiles) {
  let path = base + relative(distDir, file).replace(/\\/g, '/');
  path = path.replace(/index\.html$/, '').replace(/\.html$/, '/');
  served.add(path);
}
// Non-HTML assets are also valid targets.
(function walkAssets(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkAssets(full);
    else if (!entry.endsWith('.html')) served.add(base + relative(distDir, full).replace(/\\/g, '/'));
  }
})(distDir);

const hrefRe = /href="([^"#]*)(#[^"]*)?"/g;
const failures = [];

for (const file of htmlFiles) {
  const pagePath = base + relative(distDir, file).replace(/\\/g, '/').replace(/index\.html$/, '');
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(hrefRe)) {
    const raw = match[1];
    if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) continue; // external/mailto/protocol
    const resolved = new URL(raw, origin + pagePath);
    if (resolved.origin !== origin) continue;
    let target = resolved.pathname;
    if (!target.endsWith('/') && !/\.[a-z0-9]+$/i.test(target)) target += '/';
    if (!served.has(target)) {
      failures.push(`${relative(distDir, file)}: "${raw}" -> ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} broken internal link(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`All internal links resolve (${htmlFiles.length} pages checked, browser URL semantics).`);
