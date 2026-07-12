"""SDK-supplied observability (observability.md): agents built from the
template emit correct telemetry with zero effort. The SDK pins the semconv
mapping; agents never hand-write attribute names."""

import os
from collections.abc import MutableMapping
from typing import Any

import structlog
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def configure_logging() -> None:
    """Structured JSON logs, trace-correlated."""

    def add_trace_context(
        _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
    ) -> MutableMapping[str, Any]:
        span = trace.get_current_span()
        ctx = span.get_span_context()
        if ctx.is_valid:
            event_dict["trace_id"] = format(ctx.trace_id, "032x")
            event_dict["span_id"] = format(ctx.span_id, "016x")
        return event_dict

    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", key="time"),
            add_trace_context,
            structlog.processors.JSONRenderer(),
        ]
    )


def configure_tracing(
    service_name: str, span_processor: SpanProcessor | None = None
) -> trace.Tracer:
    endpoint = os.environ.get("ACP_OTLP_ENDPOINT", "http://localhost:4318")
    provider = TracerProvider(
        resource=Resource.create({"service.name": service_name, "service.namespace": "acp"})
    )
    provider.add_span_processor(
        span_processor or BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
    )
    trace.set_tracer_provider(provider)
    return trace.get_tracer(service_name)
