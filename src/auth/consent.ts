/** Consent page rendering (owner password form). All dynamic values are HTML-escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export interface ConsentPageOptions {
  pendingId: string;
  clientName: string;
  redirectHost: string;
  scopes: string[];
  error?: string;
  disabled?: boolean;
}

export function renderConsentPage(o: ConsentPageOptions): string {
  const err = o.error ? `<p class="err" role="alert">${escapeHtml(o.error)}</p>` : "";
  const form = o.disabled
    ? ""
    : `<form method="post" action="/authorize/consent">
<input type="hidden" name="pending" value="${escapeHtml(o.pendingId)}">
<label for="pw">Owner password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Approve</button>
</form>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Best Reads - authorize</title>
<style>
:root{--bg:#fafaf7;--fg:#1c1b19;--muted:#6b675f;--card:#fff;--line:#ddd8cc;--accent:#3d5a80;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae4;--muted:#a09b90;--card:#1f1f1c;--line:#38362f;--accent:#8fb0d8;--err:#f2b8b5}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:400px;width:100%}
h1{font-size:1.25rem;margin:0 0 8px}p{margin:8px 0;color:var(--muted)}
label{display:block;margin-top:16px;font-weight:600}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;margin-top:6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:1rem}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:var(--bg);font-size:1rem;font-weight:600;cursor:pointer}
.err{color:var(--err);font-weight:600}
</style></head><body><main>
<h1>Authorize <strong>${escapeHtml(o.clientName)}</strong></h1>
<p>This application wants to access your Best Reads library (${escapeHtml(o.scopes.join(", ") || "library")}). You will be redirected to <code>${escapeHtml(o.redirectHost)}</code>.</p>
${err}${form}
</main></body></html>`;
}
