# HyperDX K8s Deployment on M600 Cluster

**Date:** 2026-04-13
**Status:** Approved

## Context

Deploy custom HyperDX (observability platform) + OTel collector to M600 MiniPC
Kubernetes cluster. External access via Cloudflare Tunnel at
`hyperdx.alphareds.com`. Images pushed to Azure ACR (`alphareds.azurecr.io`).

## Constraints

- M600: max 8 CPU, 4GB RAM
- Cloudflare Tunnel for ingress (NodePort, same pattern as SonarQube:30900)
- PVC for stateful services (ClickHouse, MongoDB, Redis)
- Azure AD OIDC + local auth

## Architecture

```
Cloudflare Tunnel (MiniPC-M600)
  ├── hyperdx.alphareds.com → NodePort:30800 (App/UI + API)
  ├── OTel gRPC → NodePort:30417 (via private CIDR 192.168.0.0/16)
  └── OTel HTTP → NodePort:30418 (via private CIDR 192.168.0.0/16)

Namespace: hyperdx
  Deployments: app-api, otel-collector, miner
  StatefulSets: clickhouse (20Gi), mongodb (10Gi), redis (1Gi)
```

## Resource Budget

| Service | CPU req/limit | RAM req/limit |
|---------|--------------|---------------|
| ClickHouse | 500m / 2000m | 512Mi / 1.5Gi |
| MongoDB | 200m / 500m | 256Mi / 512Mi |
| Redis | 50m / 200m | 64Mi / 128Mi |
| App+API | 200m / 1000m | 256Mi / 512Mi |
| OTel Collector | 100m / 500m | 128Mi / 256Mi |
| Miner | 100m / 500m | 128Mi / 256Mi |
| **Total** | **1150m / 4700m** | **~1.3Gi / 3.2Gi** |

## Images

| Image | Source | Registry |
|-------|--------|----------|
| app+api | `packages/api/Dockerfile` + `packages/app/Dockerfile` | `alphareds.azurecr.io/hyperdx` |
| otel-collector | `docker/otel-collector/Dockerfile` | `alphareds.azurecr.io/hyperdx-otel-collector` |
| clickhouse | Stock `clickhouse/clickhouse-server:26.1-alpine` | Public |
| mongodb | Stock `mongo:5.0.32-focal` | Public |
| redis | Stock `redis:7-alpine` | Public |

## Auth

- Local auth (default)
- Azure AD OIDC:
  - Client ID: `fbd90980-84b4-4d63-b9cf-c4c053c30ec1`
  - Tenant ID: `7c3a2f70-cbef-4d18-b100-ee3e95b2cba3`
  - Issuer: `https://login.microsoftonline.com/7c3a2f70-cbef-4d18-b100-ee3e95b2cba3/v2.0`
  - Secret stored in K8s Secret

## Cloudflare Tunnel

| Hostname | Service |
|----------|---------|
| `hyperdx.alphareds.com` | `http://localhost:30800` |

OTel endpoints via private CIDR routes (192.168.0.0/16):
- gRPC: `<node-ip>:30417`
- HTTP: `<node-ip>:30418`

## Files

```
k8s/hyperdx/
├── namespace.yaml
├── secrets.yaml
├── configmap.yaml
├── clickhouse-statefulset.yaml
├── mongodb-statefulset.yaml
├── redis-statefulset.yaml
├── app-api-deployment.yaml
├── otel-collector-deployment.yaml
├── miner-deployment.yaml
├── services.yaml
└── Makefile
```
