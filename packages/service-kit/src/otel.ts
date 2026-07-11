import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { env } from './config.js';

export interface Telemetry {
  shutdown: () => Promise<void>;
}

/**
 * Tracing bootstrap for control-plane services. Exports OTLP/HTTP to the
 * collector (ACP_OTLP_ENDPOINT, default: the dev-stack collector). Platform
 * attribution attributes (acp.*) ride on individual spans; service identity
 * rides the resource.
 */
export function initTelemetry(
  serviceName: string,
  options: { spanProcessor?: SpanProcessor } = {},
): Telemetry {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
  const exporter = new OTLPTraceExporter({
    url: `${env('ACP_OTLP_ENDPOINT', 'http://localhost:4318')}/v1/traces`,
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'service.namespace': 'acp',
    }),
    spanProcessors: [options.spanProcessor ?? new BatchSpanProcessor(exporter)],
  });
  provider.register();
  return {
    shutdown: () => provider.shutdown(),
  };
}
