/** Inline CSS shared by both MCP Apps views. Light by default, dark via prefers-color-scheme or host `data-theme`. */
export const css = `
:root{--c-bg:#ffffff;--c-fg:#1f2328;--c-muted:#656d76;--c-border:#d0d7de;--c-surface:#f6f8fa;--c-accent:#2f6feb;--c-star:#d4a017;--c-quote:#eef3ff}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--c-bg:#16181d;--c-fg:#e6e8eb;--c-muted:#9aa2ab;--c-border:#33383f;--c-surface:#1f2329;--c-accent:#6ea0ff;--c-star:#e6b422;--c-quote:#1e2638}}
:root[data-theme="dark"]{--c-bg:#16181d;--c-fg:#e6e8eb;--c-muted:#9aa2ab;--c-border:#33383f;--c-surface:#1f2329;--c-accent:#6ea0ff;--c-star:#e6b422;--c-quote:#1e2638}
:root[data-theme="light"]{--c-bg:#ffffff;--c-fg:#1f2328;--c-muted:#656d76;--c-border:#d0d7de;--c-surface:#f6f8fa;--c-accent:#2f6feb;--c-star:#d4a017;--c-quote:#eef3ff}
*{box-sizing:border-box}
html,body{margin:0}
body{--bg:var(--color-background-primary,var(--c-bg));--fg:var(--color-text-primary,var(--c-fg));--muted:var(--color-text-secondary,var(--c-muted));--border:var(--color-border-primary,var(--c-border));--surface:var(--color-background-secondary,var(--c-surface));--accent:var(--c-accent);
background:var(--bg);color:var(--fg);font:14px/1.45 var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif);padding:12px}
h1{font-size:16px;margin:0 0 8px}
.muted{color:var(--muted)}
.small{font-size:12px}
.row{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;background:var(--surface);cursor:pointer;min-width:0}
.row:hover{border-color:var(--accent)}
.grow{flex:1;min-width:0}
.t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cover{flex:none;width:36px;height:54px;border-radius:4px;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px}
.cover img{width:100%;height:100%;object-fit:cover;display:block}
.cover.big{width:84px;height:126px;font-size:32px;border-radius:6px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--border);font-size:11px;color:var(--muted);white-space:nowrap}
.stars{color:var(--c-star);letter-spacing:1px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}
button,select{font:inherit;color:var(--fg);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 10px;cursor:pointer}
button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.banner{background:var(--c-quote);border-left:3px solid var(--accent);padding:6px 10px;border-radius:4px;margin-bottom:10px}
.head{display:flex;gap:14px;margin-bottom:10px}
h2{font-size:13px;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.note{padding:6px 10px;margin:0 0 6px;border-left:3px solid var(--border)}
.note.highlight{background:var(--c-quote);border-left-color:var(--accent);font-style:italic}
.desc{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.desc.open{display:block}
.err{color:#cf222e}
.empty{padding:24px 0;text-align:center}
`;
