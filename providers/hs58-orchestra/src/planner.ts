import OpenAI from 'openai';
import type { ExecutionPlan, OrchestrationResult, OrchestraRequest, OrchestraStreamEvent, PlanStep, StepResult, ProviderConfig, ProviderName } from './types.js';
import { PLANNER_SYSTEM_PROMPT, SYNTHESIZER_SYSTEM_PROMPT, UPSTREAM } from './constants.js';
import { executeStep } from './executor.js';

export async function buildPlan(request: OrchestraRequest, config: ProviderConfig): Promise<ExecutionPlan> {
  const client = new OpenAI({ apiKey: config.chutesApiKey, baseURL: UPSTREAM.chutes.base });
  const userMessage = [
    `Goal: ${request.goal}`,
    request.context ? `Context: ${request.context}` : '',
    request.budget_usd ? `Budget cap: $${request.budget_usd} USD` : '',
    request.providers?.length ? `Allowed providers: ${request.providers.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const completion = await client.chat.completions.create({
    model: config.plannerModel,
    messages: [{ role: 'system', content: PLANNER_SYSTEM_PROMPT }, { role: 'user', content: userMessage }],
    max_tokens: 1024, temperature: 0.1,
  });

  const raw     = completion.choices[0]?.message?.content ?? '{}';
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  let plan: ExecutionPlan;
  try { plan = JSON.parse(cleaned); }
  catch {
    plan = { goal: request.goal, reasoning: 'Fallback single-step plan', estimated_total_cost_usd: 0.03,
      steps: [{ id: 'step_1', provider: 'chutes', model: config.plannerModel, task: request.goal, input_from: [], parallel: true, required: true, estimated_cost_usd: 0.03 }] };
  }

  if (request.budget_usd) {
    let cumulative = 0;
    plan.steps = plan.steps.filter(s => { cumulative += s.estimated_cost_usd; return cumulative <= request.budget_usd!; });
    plan.estimated_total_cost_usd = cumulative;
  }
  if (request.providers?.length) plan.steps = plan.steps.filter(s => request.providers!.includes(s.provider));
  plan.steps = plan.steps.slice(0, config.maxPlanSteps);
  return plan;
}

function buildWaves(steps: PlanStep[]): PlanStep[][] {
  const completed = new Set<string>();
  const remaining = [...steps];
  const waves: PlanStep[][] = [];
  while (remaining.length > 0) {
    const wave: PlanStep[] = []; const still: PlanStep[] = [];
    for (const step of remaining) {
      if ((step.input_from ?? []).every(d => completed.has(d))) wave.push(step);
      else still.push(step);
    }
    if (wave.length === 0) { waves.push(remaining); break; }
    waves.push(wave);
    wave.forEach(s => completed.add(s.id));
    remaining.splice(0, remaining.length, ...still);
  }
  return waves;
}

async function synthesize(goal: string, results: StepResult[], config: ProviderConfig): Promise<string> {
  const client = new OpenAI({ apiKey: config.chutesApiKey, baseURL: UPSTREAM.chutes.base });
  const stepSummaries = results.map(r =>
    r.status === 'done'
      ? `[${r.step_id} — ${r.provider}/${r.model}]\n${r.output}`
      : `[${r.step_id} — ${r.provider}/${r.model}] FAILED: ${r.error}`
  ).join('\n\n---\n\n');
  const completion = await client.chat.completions.create({
    model: config.synthesizerModel,
    messages: [{ role: 'system', content: SYNTHESIZER_SYSTEM_PROMPT }, { role: 'user', content: `Goal: ${goal}\n\nStep outputs:\n\n${stepSummaries}` }],
    max_tokens: 2048, temperature: 0.4,
  });
  return completion.choices[0]?.message?.content ?? 'Unable to synthesize result.';
}

export async function orchestrate(request: OrchestraRequest, config: ProviderConfig, onEvent?: (event: OrchestraStreamEvent) => void): Promise<OrchestrationResult> {
  const globalStart = Date.now();
  const emit = (event: OrchestraStreamEvent['event'], data: any) => onEvent?.({ event, data, timestamp: Date.now() });

  let plan: ExecutionPlan;
  if (request.mode === 'pipeline' && request.steps?.length) {
    plan = { goal: request.goal, steps: request.steps, estimated_total_cost_usd: request.steps.reduce((s, x) => s + x.estimated_cost_usd, 0), reasoning: 'User-provided pipeline' };
  } else {
    plan = await buildPlan(request, config);
  }
  emit('plan', plan);

  if (request.mode === 'plan') {
    return { goal: plan.goal, plan, steps: [], synthesis: '(plan-only mode — set mode: "auto" to execute)', total_cost_usd: 0, total_duration_ms: Date.now() - globalStart, providers_used: [] };
  }

  const allResults: StepResult[] = [];
  const priorOutputs = new Map<string, string>();
  for (const wave of buildWaves(plan.steps)) {
    emit('step_start', { steps: wave.map(s => s.id) });
    const waveResults = await Promise.all(wave.map(step => executeStep(step, config, priorOutputs)));
    for (const result of waveResults) {
      allResults.push(result);
      if (result.output) priorOutputs.set(result.step_id, result.output);
      emit(result.status === 'done' ? 'step_done' : 'step_fail', result);
    }
  }

  emit('synthesis', { status: 'synthesizing', steps_completed: allResults.filter(r => r.status === 'done').length });
  const synthesis = await synthesize(plan.goal, allResults, config);
  const totalCost = allResults.reduce((s, r) => s + r.cost_usd, 0);
  const providersUsed = [...new Set(allResults.map(r => r.provider))] as ProviderName[];
  const result: OrchestrationResult = { goal: plan.goal, plan, steps: allResults, synthesis, total_cost_usd: totalCost, total_duration_ms: Date.now() - globalStart, providers_used: providersUsed };
  emit('done', result);
  return result;
}
