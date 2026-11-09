import { performance } from 'node:perf_hooks';
import { LabError } from '../util/errors.js';
import type { LabConfig } from '../config/load.js';

export interface BudgetSnapshot {
  generated_model_requests: number; followup_model_requests: number; generation_attempts: number; http_attempts: number;
  planner_turns: number; tool_calls: number; execution_segments: number; elapsed_ms: number;
  limits: Record<string, number | null>;
}

/** Hard, host-enforced run budgets. Generated code can read the remaining budget but never change it. */
export class Budget {
  private started = performance.now();
  generatedRequests = 0; followups = 0; generationAttempts = 0; httpAttempts = 0; plannerTurns = 0; toolCalls = 0; segments = 0;
  constructor(readonly limits: LabConfig['budgets'], readonly code: LabConfig['code_mode']) {}

  elapsed(): number { return performance.now() - this.started; }
  remainingWallMs(): number { return Math.max(0, this.limits.max_job_wall_time_ms - this.elapsed()); }
  checkWall(): void { if (this.remainingWallMs() <= 0) throw new LabError('budget_exceeded', 'Run wall-time budget exhausted', { details: { limit: 'max_job_wall_time_ms' } }); }

  /** Reserve one logical model request (not counting its retries). */
  reserveModelRequest(kind: 'discovery' | 'inspection' | 'planner' | 'followup'): void {
    this.checkWall();
    if (this.generatedRequests + 1 > this.limits.max_generated_model_requests) throw new LabError('budget_exceeded', `Model-request budget exhausted (${this.limits.max_generated_model_requests})`, { details: { limit: 'max_generated_model_requests', kind } });
    if (kind === 'followup' && this.followups + 1 > this.limits.max_followup_model_requests) throw new LabError('budget_exceeded', `Follow-up budget exhausted (${this.limits.max_followup_model_requests})`, { details: { limit: 'max_followup_model_requests' } });
    if (kind === 'planner' && this.plannerTurns + 1 > this.code.max_planner_turns) throw new LabError('budget_exceeded', `Planner-turn budget exhausted (${this.code.max_planner_turns})`, { details: { limit: 'max_planner_turns' } });
    this.generatedRequests++;
    if (kind === 'followup') this.followups++;
    if (kind === 'planner') this.plannerTurns++;
  }
  /** Each generation attempt including retries. */
  reserveGenerationAttempt(): void {
    if (this.generationAttempts + 1 > this.limits.max_generation_attempts_including_retries) throw new LabError('budget_exceeded', 'Generation-attempt budget (including retries) exhausted', { details: { limit: 'max_generation_attempts_including_retries' } });
    this.generationAttempts++;
  }
  /** Every HTTP attempt, including readiness polls and uploads. */
  reserveHttpAttempt(): void {
    this.checkWall();
    if (this.httpAttempts + 1 > this.limits.max_http_attempts_per_job) throw new LabError('budget_exceeded', 'HTTP-attempt budget exhausted', { details: { limit: 'max_http_attempts_per_job' } });
    this.httpAttempts++;
  }
  reserveToolCall(): void {
    if (this.toolCalls + 1 > this.code.max_tool_calls) throw new LabError('budget_exceeded', `Tool-call budget exhausted (${this.code.max_tool_calls})`, { details: { limit: 'max_tool_calls' } });
    this.toolCalls++;
  }
  reserveSegment(): void {
    if (this.segments + 1 > this.code.max_execution_segments) throw new LabError('budget_exceeded', `Execution-segment budget exhausted (${this.code.max_execution_segments})`, { details: { limit: 'max_execution_segments' } });
    this.segments++;
  }
  snapshot(): BudgetSnapshot {
    return {
      generated_model_requests: this.generatedRequests, followup_model_requests: this.followups, generation_attempts: this.generationAttempts,
      http_attempts: this.httpAttempts, planner_turns: this.plannerTurns, tool_calls: this.toolCalls, execution_segments: this.segments, elapsed_ms: this.elapsed(),
      limits: {
        max_generated_model_requests: this.limits.max_generated_model_requests, max_followup_model_requests: this.limits.max_followup_model_requests,
        max_generation_attempts_including_retries: this.limits.max_generation_attempts_including_retries, max_http_attempts_per_job: this.limits.max_http_attempts_per_job,
        max_job_wall_time_ms: this.limits.max_job_wall_time_ms, max_planner_turns: this.code.max_planner_turns, max_tool_calls: this.code.max_tool_calls,
        max_execution_segments: this.code.max_execution_segments, max_estimated_run_cost_usd: this.limits.max_estimated_run_cost_usd,
      },
    };
  }
}
