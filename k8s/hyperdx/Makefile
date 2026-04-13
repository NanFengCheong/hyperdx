REGISTRY := alphareds.azurecr.io
HDX_IMAGE := $(REGISTRY)/hyperdx
OTEL_IMAGE := $(REGISTRY)/hyperdx-otel-collector
TAG ?= latest
NAMESPACE := hyperdx
KUBECONFIG ?= $(HOME)/.kube/config

.PHONY: login build push deploy status logs teardown

DOCKER_USER ?= docker-user
DOCKER_PASS ?= $(ACR_PASSWORD)

## Docker
login:
	docker login $(REGISTRY) -u $(DOCKER_USER) -p '$(DOCKER_PASS)'

build:
	cd ../.. && docker buildx build --platform linux/amd64 -f docker/hyperdx/Dockerfile \
		--build-context clickhouse=./docker/clickhouse \
		--build-context otel-collector=./docker/otel-collector \
		--build-context hyperdx=./docker/hyperdx \
		--build-context api=./packages/api \
		--build-context app=./packages/app \
		--target prod -t $(HDX_IMAGE):$(TAG) --push .
	cd ../.. && docker buildx build --platform linux/amd64 -f docker/otel-collector/Dockerfile \
		-t $(OTEL_IMAGE):$(TAG) --push .

build-push: build

## Kubernetes
create-acr-secret:
	kubectl create secret docker-registry acr-pull-secret \
		--docker-server=$(REGISTRY) \
		--docker-username=$(DOCKER_USER) \
		--docker-password='$(DOCKER_PASS)' \
		-n $(NAMESPACE) \
		--dry-run=client -o yaml | kubectl apply -f -

deploy:
	kubectl apply -f namespace.yaml
	$(MAKE) create-acr-secret
	kubectl apply -f secrets.yaml
	kubectl apply -f configmap.yaml
	kubectl apply -f clickhouse-statefulset.yaml
	kubectl apply -f mongodb-statefulset.yaml
	kubectl apply -f app-api-deployment.yaml
	kubectl apply -f otel-collector-deployment.yaml
	kubectl apply -f services.yaml

status:
	kubectl get all -n $(NAMESPACE)
	@echo "---"
	kubectl get pvc -n $(NAMESPACE)

logs:
	kubectl logs -n $(NAMESPACE) -l app.kubernetes.io/part-of=hyperdx --all-containers --tail=50

logs-app:
	kubectl logs -n $(NAMESPACE) -l app.kubernetes.io/name=app-api -f

logs-otel:
	kubectl logs -n $(NAMESPACE) -l app.kubernetes.io/name=otel-collector -f

logs-ch:
	kubectl logs -n $(NAMESPACE) -l app.kubernetes.io/name=clickhouse -f

restart:
	kubectl rollout restart deployment -n $(NAMESPACE)

teardown:
	kubectl delete namespace $(NAMESPACE)

port-forward-app:
	kubectl port-forward -n $(NAMESPACE) svc/app-api 8080:8080

port-forward-otel:
	kubectl port-forward -n $(NAMESPACE) svc/otel-collector 4317:4317 4318:4318
