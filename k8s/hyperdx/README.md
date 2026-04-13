# HyperDX on M600 MiniPC (K3s)

Deploy HyperDX observability platform to the M600 MiniPC Kubernetes cluster with Cloudflare Tunnel ingress.

## Prerequisites

- kubectl configured with M600 context: `kubectl config use-context M600`
- Docker with buildx (for cross-compilation to linux/amd64)
- ACR credentials (`ACR_PASSWORD` env var)
- Cloudflare Tunnel route: `hyperdx.alphareds.com → http://localhost:30800`

## Architecture

```
Cloudflare Tunnel (MiniPC-M600)
  └── hyperdx.alphareds.com → NodePort:30800 (App UI + API)

OTel Ingestion (private network):
  ├── gRPC  → NodePort:30417
  └── HTTP  → NodePort:30418

Namespace: hyperdx
  Deployments: app-api, otel-collector
  StatefulSets: clickhouse (20Gi PVC), mongodb (10Gi PVC)
```

## Resource Budget (4GB RAM total)

| Service | CPU req/limit | RAM req/limit |
|---------|--------------|---------------|
| ClickHouse | 500m / 2 | 512Mi / 1.5Gi |
| MongoDB | 200m / 500m | 256Mi / 512Mi |
| App+API | 200m / 1 | 256Mi / 512Mi |
| OTel Collector | 100m / 500m | 128Mi / 256Mi |

## Quick Start

### 1. Switch to M600 cluster

```bash
kubectl config use-context M600
```

### 2. Build and push images

```bash
cd k8s/hyperdx
export ACR_PASSWORD='<your-acr-password>'
make build
```

This builds `linux/amd64` images and pushes directly to `alphareds.azurecr.io`.

### 3. Create secrets

Secrets are NOT stored in git. Create them manually:

```bash
# ACR pull secret (created automatically by make deploy)

# Application secrets
kubectl create secret generic hyperdx-secrets -n hyperdx \
  --from-literal=HYPERDX_API_KEY=<team-api-key> \
  --from-literal=OIDC_CLIENT_SECRET=<azure-ad-client-secret> \
  --from-literal=SMTP_PASS=<smtp-password> \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 4. Deploy

```bash
make deploy
```

### 5. Verify

```bash
make status
```

All pods should be `Running` and PVCs `Bound`.

### 6. Configure Cloudflare Tunnel

In Cloudflare Zero Trust dashboard, add a public hostname route:

| Hostname | Service |
|----------|---------|
| `hyperdx.alphareds.com` | `http://localhost:30800` |

### 7. Access

Open `https://hyperdx.alphareds.com` and create your account.

## Sending Telemetry

### From apps in the same K8s cluster

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.hyperdx.svc.cluster.local:4318
OTEL_EXPORTER_OTLP_HEADERS="Authorization=<team-api-key>"
```

### From apps on the local network

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://192.168.100.121:30418
OTEL_EXPORTER_OTLP_HEADERS="Authorization=<team-api-key>"
```

### From browser (RUM)

The app proxies `/v1/*` to the OTel collector via Next.js rewrites. Use:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://hyperdx.alphareds.com
```

> **Auth note:** The collector uses bearer token auth with an empty scheme. The `Authorization` header value is the team API key directly (no `Bearer ` prefix).

## Configuration

### Environment Variables

Key env vars in `configmap.yaml`:

| Variable | Description |
|----------|-------------|
| `FRONTEND_URL` | Public URL (`https://hyperdx.alphareds.com`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Internal OTel endpoint for app self-instrumentation |
| `HDX_INTERNAL_COLLECTOR_URL` | Shown in integration guide as internal K8s endpoint |
| `OIDC_ISSUER` | Azure AD OIDC issuer URL |
| `OIDC_CLIENT_ID` | Azure AD application client ID |
| `SMTP_HOST` / `SMTP_PORT` | SMTP server for email notifications |

### OIDC (Azure AD)

Configured via env vars in `configmap.yaml`. The callback URL is:
```
https://hyperdx.alphareds.com/api/auth/oidc/callback
```

### SMTP

Configured for Aliyun DirectMail (port 465, TLS). Password stored in K8s secret.

## Operations

```bash
make status          # Check all resources and PVCs
make logs            # All pod logs (last 50 lines)
make logs-app        # Stream app-api logs
make logs-otel       # Stream OTel collector logs
make logs-ch         # Stream ClickHouse logs
make restart         # Restart all deployments
make teardown        # Delete entire namespace (destructive!)
make port-forward-app   # Forward app to localhost:8080
make port-forward-otel  # Forward OTel to localhost:4317/4318
```

## Rebuilding

After code changes:

```bash
cd k8s/hyperdx
export ACR_PASSWORD='<your-acr-password>'
make build                                    # Build + push amd64 images
kubectl rollout restart deployment -n hyperdx  # Pull new images
```

## ClickHouse Tuning

The ClickHouse config is tuned for 4GB total system RAM:
- `uncompressed_cache_size`: 128MB (default 8GB)
- `mark_cache_size`: 256MB (default 5GB)
- `max_memory_usage`: 1GB per query (default 10GB)
- `max_concurrent_queries`: 50 (default 100)
- Log level: `warning` (reduced from `debug`)
