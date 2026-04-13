# Implementation Plan: HyperDX K8s Deployment

**Design:** `2026-04-13-k8s-deployment-design.md`

## Phase 1: K8s Manifests (parallel — no dependencies between files)

### Step 1.1: Namespace + Secrets
- Create `k8s/hyperdx/namespace.yaml` — namespace `hyperdx`
- Create `k8s/hyperdx/secrets.yaml` — ACR pull secret, OIDC client secret, HyperDX API key

### Step 1.2: ConfigMaps
- Create `k8s/hyperdx/configmap.yaml` — all env vars (MONGO_URI, CLICKHOUSE_ENDPOINT, OIDC config, FRONTEND_URL, etc.)
- Embed ClickHouse config.xml and users.xml
- Embed OTel collector config.yaml

### Step 1.3: StatefulSets (parallel)
- Create `k8s/hyperdx/clickhouse-statefulset.yaml` — 20Gi PVC, config from ConfigMap
- Create `k8s/hyperdx/mongodb-statefulset.yaml` — 10Gi PVC
- Create `k8s/hyperdx/redis-statefulset.yaml` — 1Gi PVC

### Step 1.4: Deployments (parallel)
- Create `k8s/hyperdx/app-api-deployment.yaml` — single pod, env from ConfigMap/Secret
- Create `k8s/hyperdx/otel-collector-deployment.yaml` — single pod, config from ConfigMap
- Create `k8s/hyperdx/miner-deployment.yaml` — single pod

### Step 1.5: Services
- Create `k8s/hyperdx/services.yaml` — all Service definitions
  - app-api: NodePort 30800
  - otel-collector: NodePort 30417 (gRPC), 30418 (HTTP)
  - clickhouse, mongodb, redis: ClusterIP (internal only)

## Phase 2: Docker Build + Push

### Step 2.1: Build custom images
- Build `alphareds.azurecr.io/hyperdx:latest` from repo Dockerfiles
- Build `alphareds.azurecr.io/hyperdx-otel-collector:latest` from `docker/otel-collector/Dockerfile`

### Step 2.2: Push to ACR
- `docker login alphareds.azurecr.io`
- Push both images

## Phase 3: Deploy

### Step 3.1: Apply manifests
- `kubectl apply -f k8s/hyperdx/namespace.yaml`
- `kubectl apply -f k8s/hyperdx/secrets.yaml`
- `kubectl apply -f k8s/hyperdx/configmap.yaml`
- `kubectl apply -f k8s/hyperdx/` (all remaining)

### Step 3.2: Verify
- Check all pods running: `kubectl get pods -n hyperdx`
- Check PVCs bound: `kubectl get pvc -n hyperdx`
- Check services: `kubectl get svc -n hyperdx`

## Phase 4: Cloudflare Tunnel Route

### Step 4.1: Add tunnel route
- Add `hyperdx.alphareds.com → http://localhost:30800` in Cloudflare dashboard

### Step 4.2: Verify end-to-end
- Access `https://hyperdx.alphareds.com`
- Test OIDC login
- Send test telemetry to `<node-ip>:30418`

## Phase 5: Makefile

### Step 5.1: Create deployment Makefile
- `k8s/hyperdx/Makefile` with targets: `build`, `push`, `deploy`, `status`, `logs`, `teardown`
