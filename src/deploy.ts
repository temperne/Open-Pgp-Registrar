// "Download this county's program": a ready-to-deploy package for another county.
// The single HTML file with the county's settings built in as its defaults (a
// settings block the app reads at start-up), the chosen seal, and a security policy
// that points Sign together at the county's own address, plus the Cloudflare Worker
// that serves it, relays its signing rooms and counts its use. Each copy can make
// the next county's copy.
import { zipSync, strToU8 } from 'fflate';
import { BRAND, MASTER_URL, MASTER_FALLBACK_URL } from './brand';
import { safeText } from './text';

export interface CountyConfig {
  name: string;
  expansion: string;
  county: string;
  state: string;
  recorderOffice: string;
  projectUrl: string;
  entityAuthority: string;
  /** Where the county will host it (https); '' leaves Sign together off. */
  relayUrl: string;
  /** Cloudflare Web Analytics token: the county's own, or the master site's. */
  analyticsToken: string;
  /** Which version it was made from, and when. */
  madeFrom: string;
  /** Who made this copy (optional): name, and title or authority. */
  publisher?: string;
}

/** The signature over public/index.html, when the maker signed it. */
export interface PackageSignature {
  signature: Uint8Array;
  publicArmored: string;
  fingerprint: string;
}

export const CONFIG_ID = 'stop-config';

/** The settings a county's copy carries (null in the original build). */
export function bakedConfig(): Partial<CountyConfig> | null {
  const el = document.getElementById(CONFIG_ID);
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as Partial<CountyConfig>;
  } catch {
    return null;
  }
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'stop';

/** The county's HTML file: this page's original HTML with the settings, seal and security policy changed. */
export function countyHtml(pristine: string, cfg: CountyConfig, seal: { type: string; base64: string } | null): string {
  if (!pristine) throw new Error('This page could not copy itself. Download the tool and open the saved copy to make a county’s program.');
  let html = pristine;
  // 1. The settings block (replacing one from an earlier copy). "<" is escaped so it can't end the script.
  const json = JSON.stringify(cfg, null, 1).replace(/</g, '\\u003c');
  const block = `<script type="application/json" id="${CONFIG_ID}">${json}</script>`;
  html = html.replace(new RegExp(`<script type="application/json" id="${CONFIG_ID}">[\\s\\S]*?</script>\\s*`), '');
  // The real end of the head is its last "</head>": the app's own code (inside the head)
  // contains that text too.
  const end = html.lastIndexOf('</head>');
  if (end < 0) throw new Error('This page could not copy itself.');
  html = `${html.slice(0, end)}${block}\n  ${html.slice(end)}`;
  // 2. The seal.
  if (seal) {
    html = html.replace(/(<img[^>]*id="brand-seal"[^>]*\ssrc=")data:image\/[a-z]+;base64,[^"]*(")/, `$1data:${seal.type};base64,${seal.base64}$2`);
    html = html.replace(/(<img[^>]*id="brand-seal"[^>]*\salt=")[^"]*(")/, `$1${escapeAttr(`${cfg.county} seal`)}$2`);
  }
  // 3. The security policy: connections to the county's own address only (or none).
  const host = cfg.relayUrl ? new URL(cfg.relayUrl).host : '';
  // Its own relay (if any), the master site (update check), and the analytics endpoint.
  const master = new URL(MASTER_URL).host;
  // A copy that relays through the master site may also use the master's backup server.
  const backup = host === master ? ` https://${new URL(MASTER_FALLBACK_URL).host} wss://${new URL(MASTER_FALLBACK_URL).host}` : '';
  html = html.replace(
    /connect-src [^;"]*/,
    `connect-src 'self'${host ? ` https://${host} wss://${host}` : ''}${backup}${host !== master ? ` https://${master}` : ''} https://cloudflareinsights.com`,
  );
  // 4. The page title.
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(cfg.name)}</title>`);
  return html;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

export function workerToml(name: string) {
  return `# Cloudflare Worker for ${name}: serves the program, relays its signing rooms and counts
# its use. Deploy:  npm install && npx wrangler login && npx wrangler deploy
name = "${slug(name)}"
main = "src/index.ts"
compatibility_date = "2025-09-01"
send_metrics = false

[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Room"]

[[analytics_engine_datasets]]
binding = "STATS"
dataset = "stop_usage"
`;
}

export function workerReadme(cfg: CountyConfig, signed?: PackageSignature | null) {
  const name = slug(cfg.name);
  return `# ${cfg.name}

The ${BRAND.expansion} program for ${cfg.county}, ${cfg.state}, ready to put online.
Made from the open-source S.T.O.P. tool (${cfg.madeFrom}): https://github.com/temperne/Open-Pgp-Registrar

- \`public/index.html\`: the whole program in one file. It works on its own: open it in a
  browser, or put it on any web server. Its defaults: ${cfg.county}, ${cfg.state}; deeds are
  recorded with the ${cfg.recorderOffice}.
- \`src/index.ts\`, \`wrangler.toml\`, \`package.json\`: a Cloudflare Worker that serves it,
  relays its signing rooms (Sign together) and counts page loads, downloads and rooms by
  country (no tracking in the page).

## Put it online with Cloudflare (free plan)

\`\`\`sh
npm install
npx wrangler login     # once
npx wrangler deploy
\`\`\`

It will be at https://${name}.<your-account>.workers.dev/ (or a custom domain you add in
Cloudflare). This copy was made for ${cfg.projectUrl || 'no particular address'}.

Sign together: ${
  cfg.relayUrl && cfg.projectUrl.startsWith(cfg.relayUrl)
    ? `runs at this copy's own address, ${cfg.relayUrl}, through the Worker here. It works only when the page is loaded from exactly that address.`
    : `this copy doesn't run signing rooms; its Sign together section sends people to ${cfg.relayUrl || 'the original program'}, where they work. (You can still deploy the Worker to serve the page and count its use.)`
}
If the address differs, make a new copy with the right address from the program's
"Change county or state" panel (link builder).

${
  signed
    ? `## Check that this is the published file

${cfg.publisher ? `Published by ${cfg.publisher}. ` : ''}\`public/index.html\` is signed with the publisher's OpenPGP key
(fingerprint ${signed.fingerprint}). Compare that fingerprint with the one in the
publisher's signed release statement (PDF), then:

\`\`\`sh
gpg --import publisher-key.asc
gpg --verify index.html.sig public/index.html
sha256sum public/index.html      # must match the statement
\`\`\`

`
    : ''
}Every page and PDF says the program is proposed and not an official county form until the
county adopts it (change \`status\` in the source's \`src/brand.ts\` and rebuild).
`;
}

/** The whole package, as a zip. */
export function countyPackage(html: string | Uint8Array, cfg: CountyConfig, workerSource: string, signed?: PackageSignature | null): Uint8Array {
  const dir = `${slug(cfg.name)}/`;
  const files: Record<string, Uint8Array> = {
    [`${dir}public/index.html`]: typeof html === 'string' ? strToU8(html) : html,
    [`${dir}src/index.ts`]: strToU8(workerSource),
    [`${dir}wrangler.toml`]: strToU8(workerToml(cfg.name)),
    [`${dir}package.json`]: strToU8(
      JSON.stringify(
        { name: slug(cfg.name), private: true, type: 'module', scripts: { deploy: 'wrangler deploy', dev: 'wrangler dev' }, devDependencies: { '@cloudflare/workers-types': '^5.20261113.1', wrangler: '^4.162.0' } },
        null,
        2,
      ),
    ),
    [`${dir}README.md`]: strToU8(workerReadme(cfg, signed)),
  };
  if (signed) {
    // Outside public/ is fine too, but next to the README is where people look.
    files[`${dir}index.html.sig`] = signed.signature;
    files[`${dir}publisher-key.asc`] = strToU8(signed.publicArmored);
  }
  return zipSync(files, { level: 9 });
}

export function cleanConfig(c: CountyConfig): CountyConfig {
  const t = (s: string) => safeText(s ?? '').trim();
  return { ...c, name: t(c.name), expansion: t(c.expansion), county: t(c.county), state: t(c.state), recorderOffice: t(c.recorderOffice), entityAuthority: t(c.entityAuthority), publisher: t(c.publisher ?? '') || undefined };
}
