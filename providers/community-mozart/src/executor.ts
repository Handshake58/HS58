/**
 * Orchestra Executor
 *
 * Runs individual plan steps against upstream providers.
 * Each executor method is self-contained — it knows how to talk to its provider,
 * format the task, and return a clean string output.
 */

import type { PlanStep, StepResult, ProviderConfig } from './types.js';
import { UPSTREAM } from './constants.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJSON(url: string, init: RequestInit, timeoutMs = 30_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function llmChat(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  timeoutMs = 60_000
): Promise<string> {
  const data = await fetchJSON(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 2048, temperature: 0.3 }),
  }, timeoutMs);
  return data.choices?.[0]?.message?.content ?? '';
}

// ─── Provider executors ───────────────────────────────────────────────────────

async function runChutes(step: PlanStep, config: ProviderConfig, context: string): Promise<string> {
  return llmChat(
    UPSTREAM.chutes.base, config.chutesApiKey, step.model,
    [{ role: 'user', content: context ? `Context:\n${context}\n\nTask: ${step.task}` : step.task }],
    90_000
  );
}

async function runOpenRouter(step: PlanStep, config: ProviderConfig, context: string): Promise<string> {
  if (!config.openrouterApiKey) {
    // Fall back to chutes if openrouter key not configured
    return runChutes(step, config, context);
  }
  return llmChat(
    UPSTREAM.openrouter.base, config.openrouterApiKey, step.model,
    [{ role: 'user', content: context ? `Context:\n${context}\n\nTask: ${step.task}` : step.task }],
    90_000
  );
}

async function runDesearch(step: PlanStep, config: ProviderConfig, _context: string): Promise<string> {
  // model encodes the endpoint type: "ai-search", "web", "twitter", "crawl"
  const endpoint = step.model.replace('desearch/', '');
  const query = step.task;

  let url: string;
  let body: any;
  let method: 'GET' | 'POST' = 'POST';

  switch (endpoint) {
    case 'ai-search':
      url  = `${UPSTREAM.desearch.base}/desearch/ai/search`;
      body = { prompt: query, tools: ['web', 'hackernews', 'reddit'], count: 10, streaming: false, result_type: 'LINKS_WITH_FINAL_SUMMARY' };
      break;
    case 'web':
      url    = `${UPSTREAM.desearch.base}/web?query=${encodeURIComponent(query)}`;
      method = 'GET';
      body   = undefined;
      break;
    case 'twitter':
      url  = `${UPSTREAM.desearch.base}/desearch/ai/search/links/twitter`;
      body = { prompt: query, count: 10 };
      break;
    case 'crawl':
      url    = `${UPSTREAM.desearch.base}/web/crawl?url=${encodeURIComponent(query)}`;
      method = 'GET';
      body   = undefined;
      break;
    default:
      url  = `${UPSTREAM.desearch.base}/desearch/ai/search`;
      body = { prompt: query, tools: ['web'], count: 10, streaming: false, result_type: 'LINKS_WITH_FINAL_SUMMARY' };
  }

  const data = await fetchJSON(url, {
    method,
    headers: { Authorization: config.desearchApiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, 30_000);

  // Extract meaningful text from Desearch responses
  if (data.text) return data.text;
  if (data.results) return JSON.stringify(data.results).slice(0, 3000);
  if (data.organic_results) return data.organic_results.slice(0, 5).map((r: any) => `${r.title}: ${r.snippet}`).join('\n');
  return JSON.stringify(data).slice(0, 3000);
}

async function runE2B(step: PlanStep, config: ProviderConfig, context: string): Promise<string> {
  if (!config.e2bApiKey) throw new Error('E2B API key not configured');
  // task should be executable code
  const code = context ? `# Context:\n# ${context.split('\n').join('\n# ')}\n\n${step.task}` : step.task;

  // Create sandbox and run
  const sandbox = await fetchJSON(`${UPSTREAM.e2b.base}/sandboxes`, {
    method: 'POST',
    headers: { 'X-API-Key': config.e2bApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: 'base', timeout: 30 }),
  }, 15_000);

  try {
    const exec = await fetchJSON(`${UPSTREAM.e2b.base}/sandboxes/${sandbox.sandboxId}/process/start`, {
      method: 'POST',
      headers: { 'X-API-Key': config.e2bApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'python3', args: ['-c', code] }),
    }, 35_000);

    return `stdout:\n${exec.stdout || ''}\nstderr:\n${exec.stderr || ''}`.slice(0, 3000);
  } finally {
    // Always kill sandbox
    await fetch(`${UPSTREAM.e2b.base}/sandboxes/${sandbox.sandboxId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': config.e2bApiKey },
    }).catch(() => {});
  }
}

async function runNuminous(step: PlanStep, config: ProviderConfig, _context: string): Promise<string> {
  const job = await fetchJSON(UPSTREAM.numinous.forecast, {
    method: 'POST',
    headers: { Authorization: config.desearchApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: step.task }),
  }, 15_000);

  const predictionId = job.prediction_id;
  if (!predictionId) return JSON.stringify(job);

  // Poll up to 30s
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const result = await fetchJSON(`${UPSTREAM.numinous.forecast}/${predictionId}`, {
      headers: { Authorization: config.desearchApiKey },
    }, 10_000);
    if (result.status === 'completed' || result.probability !== undefined) {
      return `Probability: ${result.probability ?? 'N/A'}\nReasoning: ${result.reasoning ?? ''}\nSources: ${JSON.stringify(result.sources ?? []).slice(0, 500)}`;
    }
  }
  return `Forecast pending (id: ${predictionId})`;
}

async function runReplicate(step: PlanStep, config: ProviderConfig, _context: string): Promise<string> {
  if (!config.replicateApiToken) throw new Error('Replicate API token not configured');
  const prediction = await fetchJSON(`${UPSTREAM.replicate.base}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.replicateApiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: step.model, input: { prompt: step.task } }),
  }, 15_000);

  // Poll for result
  let result = prediction;
  for (let i = 0; i < 12; i++) {
    if (result.status === 'succeeded') break;
    if (result.status === 'failed')    throw new Error(result.error ?? 'Replicate failed');
    await new Promise(r => setTimeout(r, 5000));
    result = await fetchJSON(result.urls.get, {
      headers: { Authorization: `Bearer ${config.replicateApiToken}` },
    }, 10_000);
  }

  const output = result.output;
  if (Array.isArray(output)) return output.join('\n');
  return String(output ?? 'No output');
}

async function runVericore(step: PlanStep, config: ProviderConfig, _context: string): Promise<string> {
  // Vericore claim verification
  const data = await fetchJSON(`${UPSTREAM.vericore.base}/v1/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.desearchApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim: step.task }),
  }, 30_000);
  return `Verdict: ${data.verdict ?? 'unknown'}\nScore: ${data.score ?? 'N/A'}\nEvidence: ${JSON.stringify(data.evidence ?? []).slice(0, 1000)}`;
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

export async function executeStep(
  step: PlanStep,
  config: ProviderConfig,
  priorOutputs: Map<string, string>
): Promise<StepResult> {
  const start = Date.now();

  // Build context from declared dependencies
  const contextParts: string[] = [];
  for (const depId of (step.input_from ?? [])) {
    const depOutput = priorOutputs.get(depId);
    if (depOutput) contextParts.push(`[${depId}]: ${depOutput}`);
  }
  const context = contextParts.join('\n\n');

  try {
    let output: string;

    switch (step.provider) {
      case 'chutes':      output = await runChutes(step, config, context);    break;
      case 'openrouter':  output = await runOpenRouter(step, config, context); break;
      case 'desearch':    output = await runDesearch(step, config, context);   break;
      case 'e2b':         output = await runE2B(step, config, context);        break;
      case 'numinous':    output = await runNuminous(step, config, context);   break;
      case 'replicate':   output = await runReplicate(step, config, context);  break;
      case 'vericore':    output = await runVericore(step, config, context);   break;
      default:
        throw new Error(`Unknown provider: ${(step as any).provider}`);
    }

    return {
      step_id:     step.id,
      provider:    step.provider,
      model:       step.model,
      status:      'done',
      output:      output.slice(0, 8000), // cap per-step output
      cost_usd:    step.estimated_cost_usd,
      duration_ms: Date.now() - start,
    };
  } catch (err: any) {
    return {
      step_id:     step.id,
      provider:    step.provider,
      model:       step.model,
      status:      'failed',
      error:       err?.message ?? String(err),
      cost_usd:    0,
      duration_ms: Date.now() - start,
    };
  }
}
