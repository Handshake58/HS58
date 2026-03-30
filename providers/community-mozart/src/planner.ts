/**
 * Orchestra Planner + Orchestrator
 *
 * The planner uses raw fetch (same as executor) to avoid OpenAI SDK baseURL quirks.
 * The orchestrator runs the plan in topological order,
 * parallelizing independent steps and feeding outputs forward.
 */

import type {
  ExecutionPlan,
  OrchestrationResult,
  MozartRequest,
  MozartStreamEvent,
  PlanStep,
  StepResult,
  ProviderConfig,
  ProviderName,
} from './types.js';
import {
  PLANNER_SYSTEM_PROMPT,
  SYNTHESIZER_SYSTEM_PROMPT,
  UPSTREAM,
} from './constants.js';
import { executeStep } from './executor.js';

// ─── Raw LLM helper (same pattern as executor, no SDK dependency) ──────────────

async function chutesChat(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  maxTokens = 1024,
  temperature = 0.1
): Promise<string> {
  const res = await fetch(`${UPSTREAM.chutes.base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  return (msg?.content || msg?.reasoning_content) ?? '';
}

// ─── Planner ──────────────────────────────────────────────────────────────────

export async function buildPlan(
  request: MozartRequest,
  config: ProviderConfig
): Promise<ExecutionPlan> {
  const userMessage = [
    `Goal: ${request.goal}`,
    request.context ? `Context: ${request.context}` : '',
    request.budget_usd ? `Budget cap: $${request.budget_usd} USD` : '',
    request.providers?.length
      ? `Allowed providers: ${request.providers.join(', ')}`
      : '',
  ].filter(Boolean).join('\n');

  const raw = await chutesChat(
    config.chutesApiKey,
    config.plannerModel,
    [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ],
    1024,
    0.1
  );

  // Strip markdown code fences if the model wraps in ```json
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  let plan: ExecutionPlan;
  try {
    plan = JSON.parse(cleaned);
  } catch {
    // Fallback: single-step plan using chutes
    plan = {
      goal: request.goal,
      reasoning: 'Fallback single-step plan (planner parse error)',
      estimated_total_cost_usd: 0.03,
      steps: [{
        id:                   'step_1',
        provider:             'chutes',
        model:                config.plannerModel,
        task:                 request.goal,
        input_from:           [],
        parallel:             true,
        required:             true,
        estimated_cost_usd:   0.03,
      }],
    };
  }

  // Enforce budget cap
  if (request.budget_usd) {
    const cap = request.budget_usd;
    let cumulative = 0;
    plan.steps = plan.steps.filter(s => {
      cumulative += s.estimated_cost_usd;
      return cumulative <= cap;
    });
    plan.estimated_total_cost_usd = cumulative;
  }

  // Enforce provider whitelist
  if (request.providers?.length) {
    plan.steps = plan.steps.filter(s => request.providers!.includes(s.provider));
  }

  // Cap at maxPlanSteps
  plan.steps = plan.steps.slice(0, config.maxPlanSteps);

  return plan;
}

// ─── Topological scheduler ────────────────────────────────────────────────────

function buildWaves(steps: PlanStep[]): PlanStep[][] {
  const completed = new Set<string>();
  const remaining = [...steps];
  const waves: PlanStep[][] = [];

  while (remaining.length > 0) {
    const wave: PlanStep[] = [];
    const still: PlanStep[] = [];

    for (const step of remaining) {
      const deps = step.input_from ?? [];
      const ready = deps.every(d => completed.has(d));
      if (ready) wave.push(step);
      else still.push(step);
    }

    if (wave.length === 0) {
      waves.push(remaining);
      break;
    }

    waves.push(wave);
    wave.forEach(s => completed.add(s.id));
    remaining.splice(0, remaining.length, ...still);
  }

  return waves;
}

// ─── Synthesizer ──────────────────────────────────────────────────────────────

async function synthesize(
  goal: string,
  results: StepResult[],
  config: ProviderConfig
): Promise<string> {
  const stepSummaries = results.map(r =>
    r.status === 'done'
      ? `[${r.step_id} — ${r.provider}/${r.model}]\n${r.output}`
      : `[${r.step_id} — ${r.provider}/${r.model}] FAILED: ${r.error}`
  ).join('\n\n---\n\n');

  return chutesChat(
    config.chutesApiKey,
    config.synthesizerModel,
    [
      { role: 'system', content: SYNTHESIZER_SYSTEM_PROMPT },
      { role: 'user',   content: `Goal: ${goal}\n\nStep outputs:\n\n${stepSummaries}` },
    ],
    2048,
    0.4
  );
}

// ─── Orchestrate ─────────────────────────────────────────────────────────────

export async function orchestrate(
  request: MozartRequest,
  config: ProviderConfig,
  onEvent?: (event: MozartStreamEvent) => void
): Promise<OrchestrationResult> {
  const globalStart = Date.now();

  const emit = (event: MozartStreamEvent['event'], data: any) => {
    onEvent?.({ event, data, timestamp: Date.now() });
  };

  // 1. Build plan
  let plan: ExecutionPlan;
  if (request.mode === 'pipeline' && request.steps?.length) {
    plan = {
      goal:                    request.goal,
      steps:                   request.steps,
      estimated_total_cost_usd: request.steps.reduce((s, x) => s + x.estimated_cost_usd, 0),
      reasoning:               'User-provided pipeline',
    };
  } else {
    plan = await buildPlan(request, config);
  }

  emit('plan', plan);

  if (request.mode === 'plan') {
    return {
      goal:             plan.goal,
      plan,
      steps:            [],
      synthesis:        '(plan-only mode — set mode: "auto" to execute)',
      total_cost_usd:   0,
      total_duration_ms: Date.now() - globalStart,
      providers_used:   [],
    };
  }

  // 2. Execute in waves
  const allResults: StepResult[] = [];
  const priorOutputs = new Map<string, string>();
  const waves = buildWaves(plan.steps);

  for (const wave of waves) {
    emit('step_start', { steps: wave.map(s => s.id) });

    const waveResults = await Promise.all(
      wave.map(step => executeStep(step, config, priorOutputs))
    );

    for (const result of waveResults) {
      allResults.push(result);
      if (result.output) priorOutputs.set(result.step_id, result.output);

      if (result.status === 'done') {
        emit('step_done', result);
      } else {
        emit('step_fail', result);
      }
    }
  }

  // 3. Synthesize
  emit('synthesis', { status: 'synthesizing', steps_completed: allResults.filter(r => r.status === 'done').length });

  const synthesis = await synthesize(plan.goal, allResults, config);

  const totalCost = allResults.reduce((s, r) => s + r.cost_usd, 0);
  const providersUsed = [...new Set(allResults.map(r => r.provider))] as ProviderName[];

  const result: OrchestrationResult = {
    goal:              plan.goal,
    plan,
    steps:             allResults,
    synthesis,
    total_cost_usd:    totalCost,
    total_duration_ms: Date.now() - globalStart,
    providers_used:    providersUsed,
  };

  emit('done', result);
  return result;
}
