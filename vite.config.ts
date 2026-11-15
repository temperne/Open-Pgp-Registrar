/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Version, build date and changelog are built into the page (About this software).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const changelog = readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf8');

// The built app is one self-contained HTML file. Owners and Recorder staff can
// save it and open it offline. The Content-Security-Policy blocks every network
// connection, so the page can't send keys or documents anywhere even if it
// tried. It is added only to the build because the dev server needs a websocket.
const csp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function offlineCsp(): Plugin {
  return {
    name: 'offline-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

/** Prints the built file's SHA-256, for publishing with each release (README). */
function fileHash(): Plugin {
  let outFile = '';
  return {
    name: 'file-hash',
    apply: 'build',
    configResolved(c) {
      outFile = `${c.root}/${c.build.outDir}/index.html`;
    },
    closeBundle() {
      const sha = createHash('sha256').update(readFileSync(outFile)).digest('hex');
      console.log(`\n  dist/index.html SHA-256: ${sha}\n`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [offlineCsp(), viteSingleFile(), fileHash()],
  define: {
    __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    __CHANGELOG__: JSON.stringify(changelog),
  },
  build: { target: 'es2022' },
  test: { testTimeout: 60000 },
});
