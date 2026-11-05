/**
 * Custom telemetry helpers.
 *
 * NOT a bootstrap. The OpenTelemetry SDK is started by the zero-code path,
 * `node --require @opentelemetry/auto-instrumentations-node/register`
 * (scripts/start-otel.sh locally, NODE_OPTIONS on the deployed workload),
 * which runs before any application module and installs the global tracer
 * and meter providers. This file only reaches for those globals, so it must
 * never construct a NodeSDK: a second SDK would register a competing
 * provider and one of the two sets of signals would silently vanish.
 *
 * Auto-instrumentation gives http/Express/pg/redis/aws-sdk spans for free
 * (the aws-sdk instrumentation also puts gen_ai.* attributes on Bedrock
 * client spans). What it cannot give us needs app knowledge:
 *
 *   - startSpan()/withSpan()  named INTERNAL spans with business attributes
 *                             around the critical path (a chat turn, a site
 *                             agent turn, one tool execution)
 *   - recordFirstToken()      perceived latency of a streamed chat turn,
 *                             which whole-response spans miss
 *   - recordLlmUsage()        token spend as a metric, by provider and model
 *   - markRequestFailed()     status ERROR on the active SERVER span when the
 *                             app reports a failure with a 200 (SSE streams)
 *
 * These are the only custom-telemetry APIs product code may touch; no
 * `@opentelemetry/*` import should appear in a controller or service.
 * Every helper is a guaranteed no-op when no SDK is registered, because the
 * OTel API returns no-op tracers and meters in that case. That keeps a plain
 * `npm start` and local runs silent with zero configuration.
 *
 * Attribute discipline: ids, enums and scalar measures only. Never message
 * content, prompts, email addresses or user ids.
 */
'use strict';

const api = require('@opentelemetry/api');

const SCOPE = 'slo-demo';

/** Lazily resolved so load order relative to the SDK register hook cannot matter. */
let tracer = null;
let firstTokenHistogram = null;
let llmTokenCounter = null;

function instruments() {
  if (tracer) return;
  tracer = api.trace.getTracer(SCOPE);
  const meter = api.metrics.getMeter(SCOPE);

  // Time to first SSE token. The server span and the Bedrock client span
  // cover the whole response, so this is the only carrier for perceived
  // latency of a streamed turn.
  firstTokenHistogram = meter.createHistogram('slo_demo.chat.first_token_ms', {
    description: 'Milliseconds from chat turn start to the first streamed token',
    unit: 'ms',
  });

  // Cost is derived in the backend from these counts rather than hardcoding
  // prices that go stale in the repo.
  llmTokenCounter = meter.createCounter('slo_demo.llm.tokens', {
    description: 'LLM tokens consumed, by provider, model and direction',
    unit: '{token}',
  });
}

/**
 * Record time to first streamed token for a chat turn.
 * @param {number} ms
 */
function recordFirstToken(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
  try {
    instruments();
    firstTokenHistogram.record(ms);
  } catch (err) {
    console.error('[telemetry] recordFirstToken failed:', err.message);
  }
}

/**
 * Record LLM token consumption for one call.
 *
 * @param {object} params
 * @param {string} params.provider  gen_ai.provider.name value, e.g. 'aws.bedrock'
 * @param {string} [params.model]
 * @param {number} [params.input_tokens]
 * @param {number} [params.output_tokens]
 */
function recordLlmUsage({ provider, model, input_tokens, output_tokens } = {}) {
  try {
    instruments();
    const base = {
      'gen_ai.provider.name': String(provider || 'unknown'),
      'gen_ai.request.model': String(model || 'unknown'),
    };
    if (input_tokens) llmTokenCounter.add(Number(input_tokens), { ...base, 'gen_ai.token.type': 'input' });
    if (output_tokens) llmTokenCounter.add(Number(output_tokens), { ...base, 'gen_ai.token.type': 'output' });
  } catch (err) {
    console.error('[telemetry] recordLlmUsage failed:', err.message);
  }
}

/**
 * Mark the active request as failed.
 *
 * The HTTP instrumentation sets status ERROR on the SERVER span only for a
 * 5xx response or an unhandled exception. The SSE chat stream answers 200
 * (headers are already flushed) and reports failures as an `error` event in
 * the body, so without this the availability SLO would count those turns as
 * good. Call it from that path only; ordinary 5xx handlers need nothing.
 *
 * @param {Error} [err]
 */
function markRequestFailed(err) {
  try {
    const active = api.trace.getActiveSpan();
    if (!active || !active.isRecording()) return;
    if (err) active.recordException(err);
    active.setStatus({
      code: api.SpanStatusCode.ERROR,
      message: err && err.message ? String(err.message) : 'failed',
    });
  } catch (_) { /* never throw */ }
}

/**
 * Open a named INTERNAL span around a unit of app work. Auto-instrumentation
 * gives the server, Bedrock, pg and redis spans; these are the business-level
 * parents that carry the few attributes an SLO reviewer filters on.
 *
 * Returns a handle that is a guaranteed no-op without a registered SDK:
 *   run(fn)             run fn with this span active, so auto-instrumented
 *                       children nest under it (returns fn's result)
 *   setAttributes(a)    add attributes later (e.g. once the outcome is known)
 *   end(a?)             finish with status UNSET (success)
 *   fail(err, a?)       record the exception, set status ERROR, finish
 *
 * @param {string} name   e.g. 'slo_demo.chat.turn'
 * @param {object} [attrs]
 */
function startSpan(name, attrs = {}) {
  let span = null;
  let ctx = null;
  try {
    instruments();
    span = tracer.startSpan(name, { kind: api.SpanKind.INTERNAL, attributes: attrs });
    ctx = api.trace.setSpan(api.context.active(), span);
  } catch (err) {
    console.error('[telemetry] startSpan failed:', err.message);
  }
  let ended = false;
  const handle = {
    run(fn) {
      return ctx ? api.context.with(ctx, fn) : fn();
    },
    setAttributes(extra = {}) {
      try { if (span) span.setAttributes(extra); } catch (_) { /* never throw */ }
      return handle;
    },
    end(extra) {
      if (ended) return;
      ended = true;
      try {
        if (!span) return;
        if (extra) span.setAttributes(extra);
        span.end();
      } catch (_) { /* never throw */ }
    },
    fail(err, extra) {
      if (ended) return;
      ended = true;
      try {
        if (!span) return;
        if (extra) span.setAttributes(extra);
        if (err) span.recordException(err);
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: err && err.message ? String(err.message) : 'failed',
        });
        span.end();
      } catch (_) { /* never throw */ }
    },
  };
  return handle;
}

/**
 * Run an async function inside a named INTERNAL span. Ends the span with
 * status UNSET on resolve, ERROR (with the exception recorded) on reject,
 * and always rethrows so callers keep their own error handling.
 *
 * @param {string} name
 * @param {object} attrs
 * @param {(span: object) => Promise<any>} fn  receives the span handle
 */
async function withSpan(name, attrs, fn) {
  const span = startSpan(name, attrs);
  try {
    const result = await span.run(() => fn(span));
    span.end();
    return result;
  } catch (err) {
    span.fail(err);
    throw err;
  }
}

module.exports = { startSpan, withSpan, recordFirstToken, recordLlmUsage, markRequestFailed };
