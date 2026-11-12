/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

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

export default defineConfig({
  base: './',
  plugins: [offlineCsp(), viteSingleFile()],
  build: { target: 'es2022' },
  test: { testTimeout: 60000 },
});
