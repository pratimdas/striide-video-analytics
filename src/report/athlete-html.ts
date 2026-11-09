import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from '../util/html.js';
import { LAB_CSS } from './styles.js';
import type { AthleteReport } from './build.js';
import { fromRoot } from '../util/paths.js';

/** Brand tokens are read from brand/tokens.css (never re-typed) and inlined so exports keep their colours. */
export const BRAND_TOKENS = readFileSync(fromRoot('brand/tokens.css'), 'utf8');
const t = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const stateLabel = (s: string) => s.replace(/_/g, ' ');
const pill = (s: string) => `<span class="pill state-${esc(s)}">${esc(stateLabel(s))}</span>`;

export interface RenderOpts { mode: 'live' | 'export'; runId?: string; videoUrl?: string; evidenceUrl?: (id: string) => string; evidenceDir?: string; consoleUrl?: string; fixtureLabel?: string | null; reportSha?: string }

function wordmark(): string {
  // Inline the unmodified SVG so exports render without a server.
  const svg = readFileSync(fromRoot('brand/striideai-wordmark.svg'), 'utf8');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function thumbSrc(o: RenderOpts, id: string): string | null {
  if (o.mode === 'live' && o.evidenceUrl) return o.evidenceUrl(id);
  if (o.evidenceDir) { const f = join(o.evidenceDir, `${id}.jpg`); if (/^[A-Za-z0-9_]+$/.test(id) && existsSync(f)) return `data:image/jpeg;base64,${readFileSync(f).toString('base64')}`; }
  return null;
}

function evButtons(o: RenderOpts, ev: Array<{ evidence_id: string; t: number }>, thumbs = false): string {
  if (!ev.length) return '<span class="muted small">No evidence frame</span>';
  const btns = ev.map((e) => (o.mode === 'live' ? `<button type="button" class="ts" data-seek="${e.t.toFixed(3)}" aria-label="Play from ${t(e.t)}">▶ ${t(e.t)}</button>` : `<span class="pill">${t(e.t)}</span>`)).join(' ');
  if (!thumbs) return btns;
  const figs = ev.slice(0, 6).map((e) => { const src = thumbSrc(o, e.evidence_id); return src ? `<figure><img src="${esc(src)}" alt="Evidence frame at ${t(e.t)}" loading="lazy"><figcaption>${t(e.t)}</figcaption></figure>` : ''; }).join('');
  return `${btns}<div class="thumbs">${figs}</div>`;
}

function section(r: AthleteReport, key: string, body: string, wide = false): string {
  const s = r.sections.find((x) => x.key === key)!;
  return `<section class="card${wide ? ' wide' : ''}" id="sec-${key}" aria-labelledby="h-${key}"><h2 id="h-${key}">${esc(s.title)} ${pill(s.state)}</h2>${s.reason ? `<p class="reason">${esc(s.reason)}</p>` : ''}${body}</section>`;
}

/** Athlete/coach report. Every value is escaped; no model HTML, scripts or URLs are rendered. */
export function renderAthleteHtml(r: AthleteReport, o: RenderOpts): string {
  const live = o.mode === 'live';
  const ctxRows = Object.entries(r.context).filter(([k]) => k !== 'supplied').map(([k, v]) => `<div>${esc(k.replace(/_/g, ' '))}</div><div>${esc(v)}</div>`).join('');
  const header = `<header class="top"><div class="brand"><img src="${wordmark()}" alt="StriideAi" width="168" height="38"><span class="endorse">by Striide</span></div>
  <div class="small muted">Report <code>${esc(r.report_id)}</code> · version ${r.report_version} · ${esc(r.created_at.slice(0, 10))}</div>
  ${live ? `<nav class="links no-print" aria-label="Report links"><a class="btn secondary" href="#sec-review_and_feedback">Review</a>${o.consoleUrl ? `<a class="btn secondary" href="${esc(o.consoleUrl)}">Internal console</a>` : ''}<button type="button" class="secondary" onclick="window.print()">Print / PDF</button></nav>` : ''}</header>`;
  const fixtureText = o.fixtureLabel ?? r.fixture_notice;
  const fixture = fixtureText ? `<div class="notice fixture" role="note"><strong>Offline fixture.</strong> ${esc(fixtureText)}</div>` : '';
  const hero = `<section class="hero" aria-label="Assessment status"><div><span class="eyebrow">Video review · Local research lab</span><h1>${esc(r.activity.skill ?? r.activity.sport ?? 'Activity not identified')}</h1><p>${esc(r.summary)}</p><p>${pill(r.status)} ${pill(r.activity.state)} <span class="small">${esc(r.status_label)}</span></p></div>
  <div class="grade" id="sec-overall_grade"><span class="eyebrow">Overall grade</span><strong>${r.grade.shown && r.grade.value !== null ? esc(r.grade.value) : '—'}</strong><span class="small">${r.grade.shown ? 'From an approved rubric' : esc(r.grade.reason ?? 'Not available')}</span></div></section>`;

  const video = section(r, 'video_and_context', `<div class="video-wrap">${live ? `<div><video id="player" controls preload="metadata" playsinline src="${esc(o.videoUrl ?? '')}" aria-label="Analysed clip"></video><div class="controls no-print"><button type="button" id="pp">Play / pause</button><span class="small muted" aria-live="polite" id="now">0:00.00</span></div></div>` : `<div><p class="muted">Playable video is available in the local interactive report. Evidence thumbnails and timestamps are included below.</p></div>`}
  <div><div class="kv"><div>Duration</div><div>${t(r.video.duration_s)}</div><div>Camera view</div><div>Not classified</div><div>Visual activity</div><div>${esc(r.activity.sport ?? 'unknown')}${r.activity.skill ? ` · ${esc(r.activity.skill)}` : ''} (${esc(r.activity.state)})</div>${r.activity.protocol ? `<div>Protocol</div><div>${esc(r.activity.protocol)}</div>` : ''}</div>
  <h3 style="margin-top:12px">Declared context</h3>${ctxRows ? `<div class="kv">${ctxRows}</div><p class="small muted">Supplied by the user; kept separate from what the video shows.</p>` : '<p class="muted small">No context supplied (no-context run). Age, identity and goals are not inferred.</p>'}</div></div>`, true);

  const summary = section(r, 'summary', `<p>${esc(r.summary)}</p>`);
  const crit = section(r, 'criterion_breakdown', r.criteria.length ? `<div class="scroll"><table><tr><th>Criterion</th><th>Coverage</th><th>Value</th></tr>${r.criteria.map((c) => `<tr><td>${esc(c.question)}</td><td>${esc(c.coverage)}</td><td>${c.value === null ? '—' : esc(c.value)}</td></tr>`).join('')}</table></div>` : '');
  const radar = section(r, 'radar', '');
  const strengths = section(r, 'strengths', r.strengths.length ? r.strengths.map((s) => `<div class="finding"><strong>${esc(s.text)}</strong><div class="small muted">Finding ${esc(s.finding_id)}</div>${evButtons(o, s.evidence, true)}</div>`).join('') : '');
  const priorities = section(r, 'priorities', r.priorities.length ? r.priorities.map((p) => `<div class="finding"><strong>${p.rank}. ${esc(p.text)}</strong><p class="small">${esc(p.reasoning)}</p><div class="small muted">Finding ${esc(p.finding_id)} · ${esc(stateLabel(p.observability))}</div>${evButtons(o, p.evidence, true)}</div>`).join('') : '');
  const dur = Math.max(r.video.duration_s, 0.001);
  const timeline = section(r, 'action_timeline', `${r.timeline.length ? `<div class="tl" role="group" aria-label="Approximate action windows">${r.timeline.map((w, i) => `<button type="button" class="seg" style="left:${((w.start_seconds / dur) * 100).toFixed(2)}%;width:${Math.max(1, ((w.end_seconds - w.start_seconds) / dur) * 100).toFixed(2)}%" ${live ? `data-seek="${w.start_seconds.toFixed(3)}" data-until="${w.end_seconds.toFixed(3)}"` : 'disabled'} aria-label="Window ${i + 1}: ${esc(w.label)} ${t(w.start_seconds)} to ${t(w.end_seconds)}"></button>`).join('')}${live ? '<div class="cursor" id="cursor" style="left:0"></div>' : ''}</div>
  <div class="scroll"><table><tr><th>Approximate window</th><th>Label</th><th class="no-print">Play</th></tr>${r.timeline.map((w) => `<tr><td>${t(w.start_seconds)}–${t(w.end_seconds)}</td><td>${esc(w.label)}</td><td class="no-print">${live ? `<button type="button" class="ts" data-seek="${w.start_seconds.toFixed(3)}" data-until="${w.end_seconds.toFixed(3)}">Play interval</button>` : ''}</td></tr>`).join('')}</table></div>` : ''}
  ${r.phases.length ? `<h3>Expected phases</h3><ol>${r.phases.map((p) => `<li>${esc(p.name)} <span class="small muted">(${esc(p.timing)})</span></li>`).join('')}</ol>` : ''}`, true);
  const findings = section(r, 'detailed_findings', r.findings.map((f) => `<div class="finding"><h3>${esc(f.question)}</h3><div class="kv"><div>Observation</div><div>${esc(f.observation)}</div>${f.interpretation ? `<div>Interpretation</div><div>${esc(f.interpretation)}</div>` : ''}<div>State</div><div>${pill(f.state)} · visibility ${esc(stateLabel(f.visibility))}</div>${f.uncertainty ? `<div>Uncertainty</div><div>${esc(f.uncertainty)}</div>` : ''}<div>Evidence</div><div>${evButtons(o, f.evidence, true)}</div></div></div>`).join(''), true);
  const technique = section(r, 'technique', r.technique.length ? `<div class="scroll"><table><tr><th>Protocol question</th><th>Answer</th><th>Visibility</th><th>Observation</th><th>Evidence</th></tr>${r.technique.map((q) => `<tr><td>${esc(q.question)}</td><td>${q.answer === null ? pill('not_assessable') : esc(q.answer)} ${q.state !== 'supported' && q.answer !== null ? pill(q.state) : ''}</td><td>${esc(stateLabel(q.visibility))}</td><td>${esc(q.observation)}</td><td>${evButtons(o, q.evidence.slice(0, 3))}</td></tr>`).join('')}</table></div>` : '', true);
  const tactics = section(r, 'tactics_and_outcomes', '');
  const pillars = section(r, 'strength_mental_nutrition', `<div class="kv">${Object.entries(r.pillars).map(([k, v]) => `<div>${esc(k.replace(/_/g, ' '))}</div><div>${pill(v)}</div>`).join('')}</div>`);
  const drills = section(r, 'drills_and_content', r.drills.length ? r.drills.map((d) => `<div class="finding"><h3>${esc(d.name)} <span class="badge">Approved</span></h3><p class="small">${esc(d.purpose.join(', '))}</p><ul class="clean">${d.instructions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${d.safety_note ? `<p class="small">${esc(d.safety_note)}</p>` : ''}${d.links.map((l) => `<a href="${esc(l.url)}" rel="noopener noreferrer">${esc(l.label)}</a>`).join(' ')}</div>`).join('') : '');
  const next = section(r, 'next_session_plan', `<p>${esc(r.next_session)}</p>`);
  const limits = section(r, 'limitations', `<ul class="clean">${r.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`, true);
  const rec = section(r, 'recording_guidance', `<ul class="clean">${r.recording_guidance.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`);
  const feedback = section(r, 'review_and_feedback', live ? `<form class="feedback no-print" id="fb"><label>Correct a finding or an event interval
    <select name="target" required>${r.findings.map((f) => `<option value="finding:${esc(f.finding_id)}">Finding ${esc(f.finding_id)}: ${esc(f.question.slice(0, 60))}</option>`).join('')}${r.timeline.map((w, i) => `<option value="interval:${i}">Window ${i + 1}: ${t(w.start_seconds)}–${t(w.end_seconds)}</option>`).join('')}</select></label>
    <label>Correction (state, answer or corrected interval) <input name="correction" required maxlength="300" placeholder="e.g. answer should be partly / interval 2.4–3.1 s"></label>
    <label>Note <textarea name="note" maxlength="1000" rows="3"></textarea></label><button type="submit">Save review against this report version</button><p class="small muted" id="fbmsg" aria-live="polite"></p></form>` : '<p class="small muted">Coach review is recorded in the local lab.</p>');
  const notes = `<section class="card wide"><h2>About this report</h2><ul class="clean small">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}<li>Times refer to seconds from the first frame of the recorded clip. Action windows are approximate.</li></ul></section>`;

  const script = live ? `<script>
(() => {
  const v = document.getElementById('player'); if (!v) return;
  let until = null;
  const off = ${Number(r.video.playback_offset_s) || 0}; // browser media time = source time + first-frame offset of the playback file
  const seek = (s, u) => { until = u === null ? null : u + off; v.currentTime = s + off + 0.001; /* inside the target frame's display interval */ const p = v.play(); if (p && p.catch) p.catch(() => {}); v.focus({preventScroll:true}); document.getElementById('player').scrollIntoView({block:'nearest'}); };
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-seek]'); if (!b) return; seek(parseFloat(b.dataset.seek), b.dataset.until ? parseFloat(b.dataset.until) : null); });
  document.getElementById('pp').addEventListener('click', () => { if (v.paused) v.play(); else v.pause(); });
  const now = document.getElementById('now'), cur = document.getElementById('cursor');
  const fmt = (s) => Math.floor(s/60) + ':' + (s%60).toFixed(2).padStart(5,'0');
  v.addEventListener('timeupdate', () => { const st = Math.max(0, v.currentTime - off); now.textContent = fmt(st); if (cur) cur.style.left = (100*st/${Math.max(0.001, r.video.duration_s)}) + '%'; if (until !== null && v.currentTime >= until) { v.pause(); until = null; } });
  window.__seekReady = true;
  const fb = document.getElementById('fb');
  if (fb) fb.addEventListener('submit', async (e) => { e.preventDefault(); const d = new FormData(fb); const [kind, id] = String(d.get('target')).split(':');
    const r = await fetch('/api/runs/${esc(o.runId ?? '')}/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_kind: kind, target_id: id, correction: d.get('correction'), note: d.get('note') || null, report_version: ${r.report_version}, report_sha256: '${esc(o.reportSha ?? '')}' }) });
    document.getElementById('fbmsg').textContent = r.ok ? 'Saved against report version ${r.report_version}.' : 'Could not save the review.'; });
})();
</script>` : '';
  const fontsHref = live ? '/brand/fonts/fonts.css' : '../../brand/fonts/fonts.css';
  const tokensHref = live ? '/brand/tokens.css' : '../../brand/tokens.css';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>StriideAi report ${esc(r.report_id)}</title>
<link rel="stylesheet" href="${fontsHref}"><link rel="stylesheet" href="${tokensHref}"><style>${BRAND_TOKENS}${LAB_CSS}</style></head>
<body><div class="wrap">${header}${fixture}${hero}<div class="grid">${video}${summary}${crit}${radar}${strengths}${priorities}${timeline}${findings}${technique}${tactics}${pillars}${drills}${next}${limits}${rec}${feedback}${notes}</div>
<div class="footer">StriideAi supports review with a coach. Decisions stay with people. This is a local research lab report, not a production Striide schema 2.1 report.</div></div>${script}</body></html>`;
}
