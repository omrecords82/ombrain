# LiteLLM Gateway — Setup (Tier 5, optional)

om-brain talks to an **OpenAI-compatible** chat/embeddings endpoint. By default that is a LAN-local Ollama (`http://127.0.0.1:11434/v1`). LiteLLM is an optional drop-in gateway that sits on loopback and presents stable `brain-*` model aliases, optionally bridging to a remote provider (e.g. OpenRouter) while keeping provider keys out of the Brain's environment.

> **Doctrine.** The Brain's circuit breaker hard-blocks `api.openai.com` and any non-RFC1918 host in production. LiteLLM must therefore run on loopback/LAN; any egress to a remote provider happens **from LiteLLM**, configured with keys held in LiteLLM's own env file — never in `om-brain.env`.

## 1. Install

```bash
sudo python3 -m pip install 'litellm[proxy]'
sudo install -d -m 0750 -o root -g om-brain /etc/litellm
```

## 2. Config — `/etc/litellm/config.yaml`

```yaml
model_list:
  - model_name: brain-reasoning
    litellm_params:
      model: ollama/qwen2.5:7b-instruct-q4_K_M
      api_base: http://127.0.0.1:11434
  - model_name: brain-classifier
    litellm_params:
      model: ollama/qwen2.5:3b-instruct-q4_K_M
      api_base: http://127.0.0.1:11434
  - model_name: nomic-embed-text
    litellm_params:
      model: ollama/nomic-embed-text
      api_base: http://127.0.0.1:11434

  # Optional remote fallback (egress happens here, not in the Brain):
  # - model_name: brain-reasoning
  #   litellm_params:
  #     model: openrouter/meta-llama/llama-3.1-70b-instruct
  #     api_key: os.environ/OPENROUTER_API_KEY

litellm_settings:
  drop_params: true
  num_retries: 2
  request_timeout: 180
router_settings:
  routing_strategy: simple-shuffle
```

## 3. Secrets — `/etc/litellm/litellm.env`

```bash
# chmod 0640, chown root:om-brain. NEVER commit.
OPENROUTER_API_KEY=sk-or-...
# Optional spend cap (USD/day) enforced by LiteLLM:
LITELLM_MAX_BUDGET=5
```

## 4. systemd — `/etc/systemd/system/litellm.service`

```ini
[Unit]
Description=LiteLLM proxy (LAN-local LLM gateway for om-brain)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/litellm/litellm.env
ExecStart=/usr/local/bin/litellm --config /etc/litellm/config.yaml --host 127.0.0.1 --port 4000
Restart=on-failure
User=om-brain
Group=om-brain

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now litellm.service
```

## 5. Point om-brain at LiteLLM

In `/etc/om-brain/om-brain.env`:

```bash
BRAIN_LLM_BASE_URL=http://127.0.0.1:4000/v1
BRAIN_LLM_REASONING_MODEL=brain-reasoning
BRAIN_LLM_CLASSIFIER_MODEL=brain-classifier
BRAIN_LLM_EMBEDDING_MODEL=nomic-embed-text
# Embeddings can stay on Ollama directly if preferred:
# BRAIN_LLM_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
```

The Brain also supports an in-process chat fallback independent of LiteLLM:

```bash
BRAIN_LLM_FALLBACK_ENABLED=true
BRAIN_LLM_FALLBACK_BASE_URL=http://127.0.0.1:11434/v1
BRAIN_LLM_FALLBACK_MODEL=qwen2.5:7b-instruct-q4_K_M
```

## 6. Verify

```bash
curl -s http://127.0.0.1:4000/v1/models | python3 -m json.tool   # expect brain-reasoning, brain-classifier, nomic-embed-text
curl -s http://127.0.0.1:8390/health                              # Brain health
```

## Operational notes

- **Ollama keep-alive.** To avoid cold-start latency, set `OLLAMA_KEEP_ALIVE=24h` (or `-1`) in the Ollama service environment so models stay resident.
- **Spend control.** Enforce budgets in LiteLLM (`LITELLM_MAX_BUDGET`) and at the provider dashboard; the Brain has no billing surface of its own.
- **Egress audit.** Any remote provider call originates from LiteLLM; keep its logs under the standard log path for the audit trail.
