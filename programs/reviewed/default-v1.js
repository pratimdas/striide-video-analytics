// Reviewed orchestration program v1 (StriideAi local lab).
// Uses only the typed, job-scoped host tools. The host enforces budgets, validation, approval and publication.
// Fixed mode imports this module directly; Code Mode embeds it in the restricted Deno executor and offers it
// to the planner as the template it may adapt.
export default async function program(tools, input) {
  const notes = [];
  const media = await tools.media.describe({});
  const disc = await tools.video.discover({});
  const cmp = disc.compare || {};
  const primary = cmp.primary || null;
  const sports = [];
  if (primary && primary.sport_uid) sports.push(primary.sport_uid);
  for (const c of cmp.competing || []) if (c.sport_uid && sports.indexOf(c.sport_uid) < 0) sports.push(c.sport_uid);

  // Protocol for the primary candidate's skill (default protocol first), bounded by the protocol budget.
  let protocol = null;
  if (primary && primary.skill_uid) {
    const cat = await tools.ontology.getCatalogue({});
    const skill = cat.skills.find((s) => s.uid === primary.skill_uid);
    if (skill && skill.protocol_uids.length) protocol = await tools.ontology.getProtocol({ protocol_uid: skill.protocol_uids[0] });
  }
  if (!protocol) notes.push('No protocol for the primary candidate; inspection focuses on recognition.');

  // Recognition overlay questions are added only when candidates conflict or confirmation is needed.
  let recognitionQuestions = [];
  if (sports.length) {
    const profiles = await tools.ontology.getRecognitionProfiles({ sport_uids: sports });
    if (cmp.conflict || (primary && primary.uncertainty !== 'low')) {
      for (const p of profiles.profiles) recognitionQuestions = recognitionQuestions.concat(p.question_uids);
    }
  }

  // Evidence: discovery windows (approximate), or the whole clip when none were returned.
  const maxWindows = 3;
  let windows = disc.action_windows.slice(0, maxWindows).map((w) => ({ window_id: w.window_id, purpose: w.label }));
  if (!windows.length) windows = [{ start_seconds: 0, end_seconds: media.duration_s, purpose: 'whole clip (no action windows returned)' }];
  const reserve = input.limits.max_frames_per_packet; // keep room for one denser follow-up packet
  const perPacket = Math.max(4, Math.min(input.limits.max_frames_per_packet, Math.floor((input.limits.max_evidence_frames_total - reserve) / windows.length)));
  for (const w of windows) w.frames = perPacket;
  const ev = await tools.media.extractEvidence({ windows: windows, context_seconds: 0.5 });
  const packetIds = ev.packets.map((p) => p.packet_id);

  const protocolQuestions = protocol ? protocol.questions.map((q) => q.uid) : [];
  const questions = recognitionQuestions.concat(protocolQuestions).slice(0, input.limits.max_questions);
  if (!questions.length) {
    notes.push('No answerable questions were compiled.');
    await tools.assessment.validate({});
    await tools.report.assemble({ proposal: { notes: notes.join(' ') } });
    return { status: 'no_questions', notes };
  }
  const first = await tools.vision.inspect({ packet_ids: packetIds, question_uids: questions, candidate_sport_uids: sports });

  // One bounded follow-up when the activity is unresolved or the two providers disagree.
  const verdict = first.activity_verdict;
  const disagree = primary && verdict.sport_uid && verdict.sport_uid !== primary.sport_uid;
  if ((verdict.state !== 'established' || disagree) && input.budgets.followups_remaining > 0 && ev.frames_used + reserve <= ev.frames_budget) {
    const main = disc.action_windows[0];
    const dense = await tools.media.extractEvidence({ windows: [main ? { window_id: main.window_id, frames: reserve, purpose: 'denser sequence for recognition follow-up' } : { start_seconds: 0, end_seconds: media.duration_s, frames: reserve, purpose: 'denser whole-clip sequence' }], context_seconds: 0.25 });
    const followQuestions = recognitionQuestions.length ? recognitionQuestions : questions;
    await tools.vision.inspect({ packet_ids: dense.packets.map((p) => p.packet_id), question_uids: followQuestions, candidate_sport_uids: sports, followup: true, reason: disagree ? 'Inspector verdict disagrees with the discovery candidate' : 'Activity not established from the first packets' });
    notes.push('One follow-up inspection was used.');
  }
  await tools.assessment.validate({});
  await tools.assessment.calculate({});
  await tools.report.assemble({ proposal: { primary_protocol_uid: protocol ? protocol.protocol_uid : undefined, notes: notes.join(' ') } });
  return { status: 'done', notes };
}
