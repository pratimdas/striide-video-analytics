/**
 * OFFLINE TEST DOUBLES for the official SDK clients. They are injected only by tests, are labelled
 * in run provenance ("offline-mock") and never produce output presented as a real analysis.
 */
import type { TwelveLabsClientLike } from '../src/providers/twelvelabs.js';
import type { GeminiClientLike } from '../src/providers/gemini.js';

export class HttpError extends Error { constructor(public statusCode: number, msg = `HTTP ${statusCode}`) { super(msg); } }

const raw = (data: any, status = 200) => ({ withRawResponse: async () => ({ data, rawResponse: { status, headers: new Headers({ 'x-request-id': 'mock-req' }) } }) });
const fail = (e: Error) => ({ withRawResponse: async () => { throw e; } });

export interface TlScenario {
  readiness?: Array<'processing' | 'ready' | 'failed'>;
  uploadError?: Error;
  analyzeErrors?: Error[]; // thrown in order before succeeding
  discovery?: any;
  finishReason?: 'stop' | 'length';
}

export function cricketDiscovery(opts: { conflict?: boolean; target?: string; windows?: Array<[number, number]> } = {}): any {
  const windows = (opts.windows ?? [[0.3, 1.6], [1.8, 2.8]]).map(([s, e], i) => ({ window_id: `w${i + 1}`, start_seconds: s, end_seconds: e, label: i === 0 ? 'Approach and delivery stride' : 'Release and follow-through' }));
  const candidates: any[] = [{ sport_uid: 'sport:cricket', skill_label: 'skill:cricket.bowling.pace', activity_type: 'discrete_ballistic', supporting_evidence: ['overarm delivery after a short run-up'], contradicting_evidence: [], uncertainty: opts.conflict ? 'medium' : 'low', distinguishing_questions: [] }];
  if (opts.conflict) candidates.push({ sport_uid: 'sport:netball', skill_label: 'passing', activity_type: 'discrete_ballistic', supporting_evidence: ['indoor court markings', 'overhead arm movement'], contradicting_evidence: ['no receiver visible'], uncertainty: 'medium', distinguishing_questions: ['Is there a delivery stride?'] });
  return { candidates, action_windows: windows, observations: [{ observation_id: 'o1', text: 'One attempt is visible.', window_ids: ['w1'] }], target: { state: opts.target ?? 'single_subject', description: 'one athlete in frame' }, limitations: ['Side-on view only; ball not clearly visible.'] };
}

export function mockTwelveLabs(sc: TlScenario = {}) {
  const log: string[] = [];
  let polls = 0; let analyzeCalls = 0;
  const client: TwelveLabsClientLike = {
    assets: {
      create: (req) => { log.push(`create:${req.filename}:${req.method}:hls=${req.enableHls}`); return sc.uploadError ? fail(sc.uploadError) : raw({ id: 'asset-mock-1', status: 'processing' }); },
      retrieve: (id) => { log.push(`retrieve:${id}`); const seq = sc.readiness ?? ['processing', 'ready']; const st = seq[Math.min(polls++, seq.length - 1)]; return raw({ id, status: st, error: st === 'failed' ? { message: 'unsupported codec (mock)' } : undefined, duration: 3 }); },
      delete: (id) => { log.push(`delete:${id}`); return raw(null, 204); },
    },
    analyze: (req) => {
      log.push(`analyze:${req.modelName}:${req.video?.type}:${req.video?.assetId}:${req.startTime ?? '-'}`);
      const e = sc.analyzeErrors?.[analyzeCalls]; analyzeCalls++;
      if (e) return fail(e);
      return raw({ id: `pegasus-mock-${analyzeCalls}`, data: JSON.stringify(sc.discovery ?? cricketDiscovery()), finishReason: sc.finishReason ?? 'stop', usage: { inputTokens: 1200, outputTokens: 300 } });
    },
  };
  return { client, log };
}

export interface GeminiScenario {
  answer?: (questionId: string, evidence: string[], call: number) => { answer: 'yes' | 'partly' | 'no' | null; visibility: string; state: string; observation?: string };
  verdict?: (call: number, candidates: string[]) => { sport_uid: string | null; state: 'established' | 'provisional' | 'unknown' };
  invalidJson?: boolean;
  plannerPrograms?: string[];
  findingsText?: string;
  extraFinding?: any;
}

export function mockGemini(sc: GeminiScenario = {}) {
  const log: Array<{ role: string; questions: string[]; evidence: string[]; model: string }> = [];
  let inspectCalls = 0; let plannerCalls = 0;
  const client: GeminiClientLike = {
    models: {
      async generateContent(params: any) {
        const parts = params.contents[0].parts as any[];
        const text = parts.filter((p) => p.text).map((p) => p.text).join('\n');
        const usageMetadata = { promptTokenCount: 2000, candidatesTokenCount: 400, totalTokenCount: 2400 };
        if (/Typed tools/.test(text)) {
          const prog = sc.plannerPrograms?.[plannerCalls++] ?? '';
          log.push({ role: 'planner', questions: [], evidence: [], model: params.model });
          return { text: JSON.stringify({ program: prog, summary: 'mock planner turn' }), candidates: [{ finishReason: 'STOP' }], usageMetadata, responseId: `planner-${plannerCalls}` };
        }
        inspectCalls++;
        const questions = [...text.matchAll(/question_id "([^"]+)"/g)].map((m) => m[1]!);
        const evidence = [...text.matchAll(/evidence_id (\S+) —/g)].map((m) => m[1]!);
        const cands = [...text.matchAll(/^- (sport:[a-z_]+)/gm)].map((m) => m[1]!);
        log.push({ role: 'inspector', questions, evidence, model: params.model });
        if (sc.invalidJson) return { text: 'not json {', candidates: [{ finishReason: 'STOP' }], usageMetadata, responseId: 'bad' };
        const v = sc.verdict?.(inspectCalls, cands) ?? { sport_uid: cands[0] ?? null, state: 'established' as const };
        const answers = questions.map((q, i) => { const a = sc.answer?.(q, evidence, inspectCalls) ?? { answer: (i % 2 === 0 ? 'yes' : 'partly') as 'yes' | 'partly', visibility: 'visible', state: 'supported' }; return { question_id: q, answer: a.answer, visibility: a.visibility, state: a.state, observation: a.observation ?? `Mock observation for ${q.split('/').pop()}.`, evidence_ids: evidence.slice(0, 2), uncertainty: null }; });
        const findings = answers.filter((a) => a.state === 'supported').map((a, i) => ({ finding_id: `f${i + 1}`, question_id: a.question_id, observation: sc.findingsText ?? a.observation, interpretation: null, evidence_ids: a.evidence_ids, state: 'supported', measurement_kind: 'observed', numeric_value: null, unit: null, uncertainty: null, approved_content_ids: [] }));
        if (sc.extraFinding && questions[0]) findings.push({ ...sc.extraFinding, question_id: questions[0], evidence_ids: evidence.slice(0, 1) });
        return { text: JSON.stringify({ activity_verdict: { ...v, evidence_ids: evidence.slice(0, 2) }, answers, findings, limitations: ['Mock limitation: single camera angle.'] }), candidates: [{ finishReason: 'STOP' }], usageMetadata, responseId: `inspect-${inspectCalls}` };
      },
    },
    files: { upload: async () => ({ name: 'files/mock' }), get: async () => ({ name: 'files/mock', state: 'ACTIVE', uri: 'https://mock/files/mock', mimeType: 'video/mp4' }), delete: async () => ({}) },
  };
  return { client, log };
}
