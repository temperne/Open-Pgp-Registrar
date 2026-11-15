// The page's own HTML, captured before the app changes anything (imported first in
// main.ts). "Download this county's program" builds a county's copy from it.
export const PRISTINE_HTML = (() => {
  try {
    return `<!doctype html>\n${document.documentElement.outerHTML}`;
  } catch {
    return '';
  }
})();
