# OpenTelemetry Integration Guide

This document explains how to retrofit URLs and configure OpenTelemetry (OTel)
SDKs to send telemetry data to a HyperDX instance. Use this when adding or
modifying integration instructions, onboarding flows, or SDK setup code.

## Architecture Overview

```
App (OTel SDK) ──OTLP──▶ OTel Collector ──▶ ClickHouse
                          (4317 gRPC)         (telemetry storage)
                          (4318 HTTP)
```

The OTel Collector is the single ingestion gateway. Apps never talk to
ClickHouse directly. The collector receives OTLP data, routes it through
pipelines (traces, metrics, logs, rrweb sessions), and exports to ClickHouse.

**Config source of truth:**
`docker/otel-collector/config.standalone.yaml` — derived from
`packages/api/src/opamp/controllers/opampController.ts`
(`buildOtelCollectorConfig()`). Keep them in sync.

## Endpoints & Ports

| Protocol | Port | Env Override                  | Path Patterns        |
|----------|------|-------------------------------|----------------------|
| HTTP     | 4318 | `HDX_DEV_OTEL_HTTP_PORT`      | `/v1/traces`, `/v1/logs`, `/v1/metrics` |
| gRPC     | 4317 | `HDX_DEV_OTEL_GRPC_PORT`      | N/A (gRPC service)   |

**Base URL construction:**

```
# HTTP (most common for SDKs)
http://<host>:4318

# gRPC (used by some SDKs like Go, Java)
http://<host>:4317
```

In the UI (`IntegrationGuideDrawer.tsx`), the endpoint is derived from the
current browser location:
```typescript
const otelEndpoint = `${window.location.protocol}//${window.location.hostname}:4318`;
```

For production/deployed environments, the endpoint should match whatever
host/port is exposed by the infrastructure (load balancer, ingress, etc.).

## Port-Based vs Path-Based Routing

### Port-Based (Local Dev)

Each service gets its own port. Simple but only works when ports are directly
accessible (local dev, direct VM access).

```
http://localhost:4318/v1/traces    ← OTel Collector HTTP
http://localhost:4317              ← OTel Collector gRPC
http://localhost:8080/api/...      ← HyperDX API
```

SDK config:
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### Path-Based (Production / Ingress)

Behind an ingress controller (NGINX, ACK, ALB), only ports 80/443 are exposed.
Traffic is routed by path prefix to different backend services.

```
https://hyperdx.example.com/api/...          → HyperDX API service
https://hyperdx.example.com/otel/v1/traces   → OTel Collector (4318)
https://hyperdx.example.com/otel/v1/logs     → OTel Collector (4318)
https://hyperdx.example.com/otel/v1/metrics  → OTel Collector (4318)
```

SDK config:
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://hyperdx.example.com/otel
```

The SDK automatically appends `/v1/traces`, `/v1/logs`, `/v1/metrics` to the
base endpoint — so the base URL should NOT include these suffixes.

**Ingress rule example (NGINX-style):**
```yaml
rules:
  - host: hyperdx.example.com
    http:
      paths:
        - path: /otel/
          pathType: Prefix
          backend:
            service:
              name: otel-collector
              port:
                number: 4318
        - path: /api/
          pathType: Prefix
          backend:
            service:
              name: hyperdx-api
              port:
                number: 8080
```

**ACK ingress note:** TLS terminates at ingress, so traffic from ingress to the
OTel Collector is plain HTTP internally. The ingress strips TLS but does NOT
strip the path prefix — the collector receives `/otel/v1/traces`. If your
collector doesn't expect the `/otel` prefix, configure path rewrite in the
ingress annotation:
```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  rules:
    - http:
        paths:
          - path: /otel(/|$)(.*)
            pathType: ImplementationSpecific
```

### gRPC Through Ingress

Path-based routing for gRPC requires ingress with gRPC support:
- **NGINX Ingress:** Use `nginx.org/grpc-services` annotation
- **ALB:** gRPC target groups (HTTP/2)
- **Simpler alternative:** Just use HTTP/protobuf (port 4318) instead of gRPC
  (4317) — works everywhere, same data, no HTTP/2 requirement

Most OTel SDKs default to HTTP/protobuf. Only switch to gRPC if you have a
specific performance reason.

### How to Detect Which Mode in the UI

The `IntegrationGuideDrawer.tsx` currently hardcodes port 4318. For deployments
behind ingress, the endpoint should come from a config value instead:

| Environment | Expected Endpoint |
|-------------|-------------------|
| Local dev   | `http://localhost:4318` |
| K8s (dev)   | `https://dev-hyperdx.example.com/otel` |
| K8s (prod)  | `https://hyperdx.example.com/otel` |

When modifying the UI, prefer reading the endpoint from an environment variable
or API response rather than constructing it from `window.location`.

### Internal vs External Endpoints

Services sending telemetry may be inside or outside the cluster. The endpoint
URL differs depending on network position.

**Internal (same K8s cluster):**

Services running inside the same cluster can reach the OTel Collector directly
via Kubernetes service DNS — no ingress, no TLS overhead, no path rewrite.

```bash
# Direct service-to-service (cluster-internal)
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.hyperdx.svc.cluster.local:4318

# Or short form (same namespace)
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

- Plain HTTP (no TLS needed — traffic stays within cluster network)
- Port-based (4318 directly), no path prefix
- Lower latency, no ingress hop
- No CORS concerns (server-to-server)

**External (outside cluster):**

Browser apps, mobile apps, or services in other networks must go through
the public ingress.

```bash
# Through ingress (external)
OTEL_EXPORTER_OTLP_ENDPOINT=https://hyperdx.example.com/otel
```

- TLS required (data traverses public network)
- Path-based routing through ingress
- Subject to WAF/DDoS protection rules
- CORS headers needed for browser SDKs

**Decision matrix:**

| Sender Location | Protocol | Endpoint | Auth |
|-----------------|----------|----------|------|
| Same K8s namespace | HTTP | `http://otel-collector:4318` | API key header |
| Different K8s namespace | HTTP | `http://otel-collector.hyperdx.svc.cluster.local:4318` | API key header |
| External backend (server) | HTTPS | `https://hyperdx.example.com/otel` | API key header |
| External browser/mobile | HTTPS | `https://hyperdx.example.com/otel` | API key header (⚠️ exposed in client code) |

**Security note for browser/mobile:** The API key is visible in client-side
code. This is acceptable because ingestion keys are write-only — they can send
telemetry but cannot read data. However, rate limiting on the ingress is
recommended to prevent abuse.

## Authentication

All OTLP requests must include the team's ingestion API key.

| Method            | Header                            | Example                     |
|-------------------|-----------------------------------|-----------------------------|
| HTTP header       | `Authorization: <api-key>`        | Used by most OTel SDKs      |
| Env var (standard)| `OTEL_EXPORTER_OTLP_HEADERS`      | `Authorization=<api-key>`   |

The API key is fetched via `api.useTeam()` → `team.apiKey` in the frontend.

**No custom headers** — we use the standard `Authorization` header, not
`x-api-key` or similar.

## Retrofitting URLs for Each Platform

### Common Environment Variables (All Platforms)

These are the standard OTel env vars that work across all SDKs:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://<host>:4318
OTEL_EXPORTER_OTLP_HEADERS="Authorization=<api-key>"
OTEL_SERVICE_NAME=my-service
```

### Node.js

**SDK:** `@opentelemetry/sdk-node` with `@opentelemetry/auto-instrumentations-node`

```typescript
// instrumentation.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  resource: new Resource({ [ATTR_SERVICE_NAME]: 'my-service' }),
  traceExporter: new OTLPTraceExporter({
    url: '<ENDPOINT>/v1/traces',
    headers: { Authorization: '<API_KEY>' },
  }),
  logRecordProcessors: [
    new SimpleLogRecordProcessor(
      new OTLPLogExporter({
        url: '<ENDPOINT>/v1/logs',
        headers: { Authorization: '<API_KEY>' },
      }),
    ),
  ],
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
```

**Run:** `node --require ./instrumentation.ts app.ts`

### Browser

**SDK:** `@opentelemetry/sdk-trace-web`

```typescript
// tracing.ts
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const exporter = new OTLPTraceExporter({
  url: '<ENDPOINT>/v1/traces',
  headers: { Authorization: '<API_KEY>' },
});

const provider = new WebTracerProvider({
  resource: new Resource({ [ATTR_SERVICE_NAME]: 'my-web-app' }),
  spanProcessors: [new BatchSpanProcessor(exporter)],
});
provider.register();
```

**Key instrumentations:**
- `DocumentLoadInstrumentation` — page load timing
- `FetchInstrumentation` — fetch API calls
- `XMLHttpRequestInstrumentation` — XHR calls

### React Native

**SDK:** `@opentelemetry/sdk-trace-base` (not `sdk-trace-web` — no DOM)

```typescript
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const provider = new BasicTracerProvider({
  resource: new Resource({ [ATTR_SERVICE_NAME]: 'my-rn-app' }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: '<ENDPOINT>/v1/traces',
        headers: { Authorization: '<API_KEY>' },
      }),
    ),
  ],
});
provider.register();
```

**Note:** Use `BasicTracerProvider`, not `WebTracerProvider`. React Native has
no browser APIs.

### ASP.NET Core

**NuGet packages:**
- `OpenTelemetry.Extensions.Hosting`
- `OpenTelemetry.Instrumentation.AspNetCore`
- `OpenTelemetry.Instrumentation.Http`
- `OpenTelemetry.Exporter.OpenTelemetryProtocol`

```csharp
// Program.cs
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("my-dotnet-service"))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(o => {
            o.Endpoint = new Uri("<ENDPOINT>");
            o.Headers = "Authorization=<API_KEY>";
        }))
    .WithLogging(l => l
        .AddOtlpExporter(o => {
            o.Endpoint = new Uri("<ENDPOINT>");
            o.Headers = "Authorization=<API_KEY>";
        }));
```

### Go

**Modules:**
- `go.opentelemetry.io/otel`
- `go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp`

```go
exporter, _ := otlptracehttp.New(ctx,
    otlptracehttp.WithEndpointURL("<ENDPOINT>/v1/traces"),
    otlptracehttp.WithHeaders(map[string]string{
        "Authorization": "<API_KEY>",
    }),
)
```

Or use env vars:
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://<host>:4318
OTEL_EXPORTER_OTLP_HEADERS="Authorization=<api-key>"
```

### Python

**Packages:**
- `opentelemetry-sdk`
- `opentelemetry-exporter-otlp-proto-http`
- `opentelemetry-instrumentation` (auto-instrumentation)

```bash
opentelemetry-instrument \
  --exporter_otlp_endpoint http://<host>:4318 \
  --exporter_otlp_headers "Authorization=<api-key>" \
  --service_name my-python-service \
  python app.py
```

Or programmatic:
```python
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

exporter = OTLPSpanExporter(
    endpoint="<ENDPOINT>/v1/traces",
    headers={"Authorization": "<API_KEY>"},
)
```

### Java

**Dependencies:** `opentelemetry-javaagent.jar` (auto-instrumentation)

```bash
java -javaagent:opentelemetry-javaagent.jar \
  -Dotel.exporter.otlp.endpoint=http://<host>:4318 \
  -Dotel.exporter.otlp.headers="Authorization=<api-key>" \
  -Dotel.service.name=my-java-service \
  -jar app.jar
```

## URL Retrofit Checklist

When modifying integration guides or adding new platforms:

1. **Always use HTTP endpoint (4318)** for browser/JS SDKs — gRPC requires
   HTTP/2 which browsers don't support for direct connections
2. **Use `/v1/traces`, `/v1/logs`, `/v1/metrics`** path suffixes for HTTP OTLP
3. **gRPC SDKs (Go, Java, .NET)** can use either 4317 (gRPC) or 4318 (HTTP)
   — prefer HTTP for simplicity unless user specifically needs gRPC
4. **Authorization header** — always `Authorization: <key>`, never custom headers
5. **Env var format** — `OTEL_EXPORTER_OTLP_HEADERS` uses `key=value` (no colon),
   not `key: value`
6. **CORS** — the collector allows all origins (`*`) so browser SDKs work
   cross-origin out of the box
7. **Service name** — always set `OTEL_SERVICE_NAME` or resource attribute
   `service.name`; it's the primary grouping key in HyperDX

## Collector Pipeline Reference

From `docker/otel-collector/config.standalone.yaml`:

| Pipeline       | Receivers       | Processors                  | Exporters          |
|----------------|-----------------|-----------------------------|--------------------|
| traces         | otlp/hyperdx    | memory_limiter, batch       | clickhouse         |
| metrics        | otlp/hyperdx    | memory_limiter, batch       | clickhouse         |
| logs/in        | otlp/hyperdx    | —                           | routing/logs       |
| logs/out-default | routing/logs  | memory_limiter, transform, batch | clickhouse    |
| logs/out-rrweb | routing/logs    | memory_limiter, batch       | clickhouse/rrweb   |

**rrweb routing:** Logs with attribute `rr-web.event` matching `.*` are routed
to the `hyperdx_sessions` table for session replay.

## Key Files

| File | Purpose |
|------|---------|
| `docker/otel-collector/config.standalone.yaml` | Collector config (receivers, pipelines, exporters) |
| `packages/api/src/opamp/controllers/opampController.ts` | Dynamic collector config builder |
| `packages/app/src/IntegrationGuideDrawer.tsx` | UI integration guide with code snippets |
| `packages/app/src/config.ts` | Default OTEL endpoint URL |
| `docker-compose.dev.yml` | Dev port mappings (4317, 4318) |
