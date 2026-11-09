/**
 * Shared stylesheet. Colours come only from the brand tokens (brand/tokens.css); a few derived
 * neutrals are declared once as tokens here. Fraunces for headings, Manrope for body.
 */
export const LAB_CSS = `
:root{--muted:#5B6072;--surface:#FFFFFF;--pitch-tint:#E7F1EA;--gold-tint:#FBF1DC;--navy-tint:#E9EAF0;--danger:#8A2A1F;--danger-tint:#F7E4E0}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-size:15px;line-height:1.6;background:var(--paper);color:var(--ink);font-family:Manrope,Arial,sans-serif}
h1,h2,h3{font-family:Fraunces,Georgia,serif;font-weight:600;letter-spacing:-.01em;line-height:1.2}
h1{font-size:clamp(28px,4vw,40px);margin:8px 0 12px}
h2{font-size:24px;margin:0 0 12px}
h3{font-size:18px;margin:0 0 6px}
a{color:var(--pitch);text-underline-offset:3px}
.wrap{max-width:72rem;margin:0 auto;padding:24px 16px 48px}
header.top{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--border)}
.brand{display:flex;flex-direction:column}
.brand img{width:168px;min-width:96px;height:auto}
.endorse{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-top:2px}
nav.links{display:flex;gap:8px;flex-wrap:wrap}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.2em;color:var(--muted)}
.hero .eyebrow{color:var(--border)}
.hero{background:var(--navy);color:var(--paper);border-radius:16px;padding:24px;display:grid;grid-template-columns:1fr minmax(180px,240px);gap:24px;margin:20px 0}
.hero p{color:var(--paper);max-width:62ch}
.grade{border-left:1px solid rgba(225,220,211,.4);padding-left:20px}
.grade strong{display:block;font-family:Fraunces,Georgia,serif;font-size:44px;line-height:1.1;margin:6px 0}
.pill{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:13px;font-weight:600;background:var(--surface);color:var(--ink)}
.pill.state-available,.pill.state-completed{background:var(--pitch-tint);border-color:var(--pitch);color:var(--ink)}
.pill.state-partial,.pill.state-completed_partial,.pill.state-provisional{background:var(--navy-tint)}
.pill.state-not_assessable,.pill.state-not_available,.pill.state-not_inferred,.pill.state-unknown,.pill.state-uncertain{background:var(--surface);color:var(--muted)}
.pill.state-review_needed,.pill.state-needs_context{background:var(--gold-tint);border-color:var(--gold)}
.pill.state-failed,.pill.state-rejected,.pill.state-cancelled{background:var(--danger-tint);border-color:var(--danger)}
.badge{display:inline-block;background:var(--gold);color:var(--ink);border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin:0 0 16px;min-width:0}
.card.wide{grid-column:1/-1}
.card .reason{color:var(--muted);margin:4px 0 10px}
.muted{color:var(--muted)}
.small{font-size:13px}
.notice{border:1px solid var(--border);border-left:4px solid var(--gold);background:var(--surface);border-radius:var(--radius);padding:12px 16px;margin:16px 0}
.notice.fixture{border-left-color:var(--danger)}
.video-wrap{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;align-items:start}
video{width:100%;max-height:70vh;background:var(--ink);border-radius:var(--radius)}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center}
button,.btn{font:inherit;font-weight:600;min-height:44px;min-width:44px;padding:8px 14px;border-radius:var(--radius);border:1px solid var(--pitch);background:var(--pitch);color:var(--surface);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
button.secondary,.btn.secondary{background:var(--surface);color:var(--ink);border-color:var(--border)}
button.ts{min-height:36px;padding:4px 10px;background:var(--surface);color:var(--pitch);border-color:var(--pitch);font-size:13px}
button:focus-visible,a:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--pitch);outline-offset:2px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px;border-bottom:1px solid var(--border);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.scroll{overflow-x:auto;max-width:100%}
ul.clean{padding-left:18px;margin:6px 0}
.thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.thumbs figure{margin:0;width:120px}
.thumbs img{width:120px;height:auto;border-radius:6px;border:1px solid var(--border);display:block}
.thumbs figcaption{font-size:12px;color:var(--muted)}
.finding{border-top:1px solid var(--border);padding:12px 0}
.finding:first-child{border-top:0}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;font-size:14px}
.tl{position:relative;height:40px;background:var(--navy-tint);border-radius:8px;margin:8px 0 4px}
.tl .seg{position:absolute;top:6px;height:28px;background:var(--pitch);opacity:.85;border-radius:6px;border:0;min-height:28px;min-width:8px;padding:0}
.tl .cursor{position:absolute;top:0;bottom:0;width:2px;background:var(--gold)}
.footer{margin-top:32px;color:var(--muted);font-size:13px;border-top:1px solid var(--border);padding-top:12px}
form.feedback{display:grid;gap:8px;max-width:640px;min-width:0}
form.feedback label{display:grid;gap:4px;min-width:0}
form.feedback select,form.feedback input,form.feedback textarea{width:100%;max-width:100%;min-width:0}
input,select,textarea{font:inherit;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--ink);min-height:44px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0}
.tabs button[aria-selected=true]{background:var(--navy);border-color:var(--navy)}
.tabs button{background:var(--surface);color:var(--ink);border-color:var(--border)}
.panel[hidden]{display:none}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:12px 0}
.metric{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px}
.metric b{display:block;font-family:Fraunces,Georgia,serif;font-size:24px}
.wf{position:relative;height:18px;background:var(--navy-tint);border-radius:4px;min-width:200px}
.wf span{position:absolute;top:2px;height:14px;border-radius:3px;background:var(--navy)}
.wf span.error{background:var(--danger)}
.wf span.ok.provider{background:var(--pitch)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--navy-tint);padding:12px;border-radius:var(--radius);font-size:12px;max-height:420px;overflow:auto}
code{font-size:12px}
@media (max-width:760px){.hero,.grid,.video-wrap{grid-template-columns:minmax(0,1fr)}.grade{border-left:0;padding-left:0;border-top:1px solid rgba(225,220,211,.4);padding-top:12px}}
@media (prefers-reduced-motion:no-preference){button,.btn{transition:background-color .2s ease-out,border-color .2s ease-out}}
@media print{
  body{background:#fff;font-size:12px}
  .no-print,video,.controls,nav.links,form.feedback,.tl .cursor{display:none!important}
  .print-only{display:block!important}
  .hero{background:#fff;color:var(--ink);border:1px solid var(--border)}
  .hero p,.hero .eyebrow{color:var(--ink)}
  .card{break-inside:avoid;border-color:#ccc}
  .grid{grid-template-columns:1fr 1fr}
  a{color:var(--ink)}
}
.print-only{display:none}
`;
