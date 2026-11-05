/**
 * Console-to-OpenTelemetry log bridge (preload).
 *
 * This app logs with console.* and morgan (which writes through console.log).
 * The zero-code auto-instrumentation only captures pino, winston and bunyan,
 * so without this preload no application logs would reach the OTLP backend.
 *
 * Loaded with `--require ./otel-console-bridge.js` AFTER the auto-
 * instrumentation register hook, so the global LoggerProvider (and its OTLP
 * exporter, when OTEL_LOGS_EXPORTER=otlp) already exists. It uses only the
 * logs API: no SDK is constructed here. Every console call still prints to
 * stdout exactly as before; a copy goes to the OTel logger with the matching
 * severity, and the SDK attaches the active trace and span ids so a log line
 * lands next to its request in the backend.
 *
 * Does nothing (no-op logger) when no SDK is registered, so it is safe to
 * leave in every start command.
 */
'use strict';

const util = require('util');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const logger = logs.getLogger('slo-demo-console');
const MAX_BODY_CHARS = 8 * 1024;

const LEVELS = {
  debug: { severityNumber: SeverityNumber.DEBUG, severityText: 'DEBUG' },
  log:   { severityNumber: SeverityNumber.INFO,  severityText: 'INFO' },
  info:  { severityNumber: SeverityNumber.INFO,  severityText: 'INFO' },
  warn:  { severityNumber: SeverityNumber.WARN,  severityText: 'WARN' },
  error: { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' },
};

// The SDK's own diagnostics and exporter errors are printed through console.
// Without this guard an export failure would log, be bridged, fail to export,
// log again, and so on.
let bridging = false;

for (const [method, level] of Object.entries(LEVELS)) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    original(...args);
    if (bridging) return;
    bridging = true;
    try {
      let body = util.format(...args);
      if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '…[truncated]';
      const attributes = { 'log.source': 'console', 'console.method': method };
      const err = args.find((a) => a instanceof Error);
      if (err) {
        attributes['exception.type'] = err.name;
        attributes['exception.message'] = err.message;
        if (err.stack) attributes['exception.stacktrace'] = err.stack;
      }
      logger.emit({ ...level, body, attributes });
    } catch (_) {
      // Telemetry must never take the process down.
    } finally {
      bridging = false;
    }
  };
}
