{{/*
Chart name (overridable via nameOverride).
*/}}
{{- define "acp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name. Used as the DNS prefix for every service, so the
in-cluster ACP_* URLs are derived from it and never hand-written.
*/}}
{{- define "acp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "acp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels stamped on every object.
*/}}
{{- define "acp.labels" -}}
helm.sh/chart: {{ include "acp.chart" . }}
app.kubernetes.io/name: {{ include "acp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: agentic-control-plane
{{- end -}}

{{/*
Per-service selector labels. Call with a dict {root, service}.
*/}}
{{- define "acp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "acp.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .service }}
{{- end -}}

{{/*
Container image. One monorepo image; the per-service args select the entrypoint.
*/}}
{{- define "acp.image" -}}
{{- $img := .Values.global.image -}}
{{- printf "%s/%s:%s" $img.registry $img.repository (default .Chart.AppVersion $img.tag) -}}
{{- end -}}

{{/*
Secret names (release-prefixed unless the operator pins one).
*/}}
{{- define "acp.credentialsSecret" -}}
{{- default (printf "%s-credentials" (include "acp.fullname" .)) .Values.credentials.secretName -}}
{{- end -}}

{{- define "acp.tokenClientsSecret" -}}
{{- default (printf "%s-token-clients" (include "acp.fullname" .)) .Values.credentials.tokenClientsSecret -}}
{{- end -}}

{{- define "acp.datastoreSecret" -}}
{{- default (printf "%s-datastore" (include "acp.fullname" .)) .Values.config.database.secretName -}}
{{- end -}}

{{- define "acp.runtimeConfigMap" -}}
{{- printf "%s-runtime" (include "acp.fullname" .) -}}
{{- end -}}

{{/*
Shared environment for every ACP pod: the in-cluster service URLs (derived from
the fullname), the data-store endpoints, OTel export, the bus tenant→account
map, and the seed-file paths mounted from the runtime ConfigMap. Secrets
(DATABASE_URL, TOKEN_CLIENTS) are pulled via secretKeyRef, never inlined.
Call with the root context ($).
*/}}
{{- define "acp.sharedEnv" -}}
{{- $fullname := include "acp.fullname" . -}}
- name: ACP_TOKEN_ISSUER
  value: {{ .Values.config.tokenIssuer | quote }}
- name: ACP_JWKS_URL
  value: "http://{{ $fullname }}-token:7101/.well-known/jwks.json"
- name: ACP_TOKEN_URL
  value: "http://{{ $fullname }}-token:7101"
- name: ACP_REGISTRY_URL
  value: "http://{{ $fullname }}-registry:7102"
- name: ACP_POLICY_URL
  value: "http://{{ $fullname }}-policy:7103"
- name: ACP_GATEWAY_URL
  value: "http://{{ $fullname }}-gateway:7100"
- name: ACP_EVALUATION_URL
  value: "http://{{ $fullname }}-evaluation:7108"
- name: ACP_LLM_GATEWAY_URL
  value: "http://{{ $fullname }}-llm-gateway:7107"
- name: ACP_NATS_URL
  value: {{ .Values.config.natsUrl | quote }}
- name: ACP_TEMPORAL_ADDRESS
  value: {{ .Values.config.temporalAddress | quote }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.config.otel.endpoint | quote }}
- name: OTEL_BSP_SCHEDULE_DELAY
  value: {{ .Values.config.otel.scheduleDelayMs | quote }}
- name: ACP_BUS_TENANT_ACCOUNTS
  value: {{ .Values.config.busTenantAccounts | toJson | quote }}
- name: ACP_ONLINE_EVAL
  value: "/etc/acp/online-eval.json"
- name: ACP_TOOL_SERVERS
  value: "/etc/acp/tool-servers.json"
- name: ACP_TOOL_CATALOG_SEED
  value: "/etc/acp/tool-servers.json"
- name: ACP_MODEL_CLASSES
  value: "/etc/acp/model-classes.json"
- name: ACP_TENANT_BUDGETS
  value: "/etc/acp/tenant-budgets.json"
- name: ACP_A2A_EXPOSURE
  value: "/etc/acp/a2a-exposure.json"
- name: ACP_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "acp.datastoreSecret" . }}
      key: {{ .Values.config.database.secretKey | quote }}
- name: ACP_TOKEN_CLIENTS
  valueFrom:
    secretKeyRef:
      name: {{ include "acp.tokenClientsSecret" . }}
      key: token-clients.json
{{- end -}}
