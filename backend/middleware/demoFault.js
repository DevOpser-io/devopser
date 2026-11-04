/**
 * FILE: backend/middleware/demoFault.js
 * PURPOSE: Deliberate fault injection for SLO demos. Off unless one of the
 * DEMO_FAULT_* variables is above zero, so a normal deploy never changes
 * behaviour. Health endpoints are never touched: App Runner's health check
 * and deploy.sh's verification gate stay green while user-facing routes
 * fail or slow down, which is what burns an error budget in a realistic way.
 *
 *   DEMO_FAULT_ERROR_RATE    share of requests (0..1) answered with HTTP 500
 *   DEMO_FAULT_LATENCY_RATE  share of requests (0..1) delayed by DEMO_FAULT_LATENCY_MS
 *   DEMO_FAULT_LATENCY_MS    delay in milliseconds (default 900)
 *
 * The values reach the deployed workload as CloudFormation parameters
 * (deploy/apprunner/cloudformation.yaml) that deploy.sh reads from the same
 * environment variables. Deploy once with a rate set to stage the incident,
 * once more with the defaults to stage the fix; both deploys emit a
 * dash0.deployment marker, so the SLO charts show the release that broke
 * things and the release that fixed them.
 *
 * A 500 from here is a real server error as far as the HTTP instrumentation
 * is concerned: the SERVER span gets status ERROR and the availability SLO
 * counts it as a bad event. No telemetry code is needed.
 */
const EXEMPT = ['/health', '/api/health', '/static', '/favicon.ico'];

function share(name) {
  const v = Number.parseFloat(process.env[name] || '0');
  return Number.isFinite(v) && v > 0 ? Math.min(v, 1) : 0;
}

function demoFault() {
  const errorRate = share('DEMO_FAULT_ERROR_RATE');
  const latencyRate = share('DEMO_FAULT_LATENCY_RATE');
  const latencyMs = Math.max(0, Number.parseInt(process.env.DEMO_FAULT_LATENCY_MS || '900', 10) || 0);
  if (errorRate === 0 && latencyRate === 0) {
    return (req, res, next) => next();
  }
  console.warn(`[demo-fault] ACTIVE: ${Math.round(errorRate * 100)}% of requests fail with 500, ` +
    `${Math.round(latencyRate * 100)}% are delayed by ${latencyMs} ms (health endpoints exempt)`);
  return (req, res, next) => {
    if (EXEMPT.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
    const failing = Math.random() < errorRate;
    const delay = Math.random() < latencyRate ? latencyMs : 0;
    const proceed = () => {
      if (failing) {
        return res.status(500).type('text/plain').send('demo fault: injected failure (DEMO_FAULT_ERROR_RATE)');
      }
      return next();
    };
    if (delay > 0) {
      setTimeout(proceed, delay);
    } else {
      proceed();
    }
  };
}

module.exports = demoFault;
