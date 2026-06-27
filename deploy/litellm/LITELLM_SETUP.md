# LiteLLM Proxy Setup Guide

This guide covers installing and configuring LiteLLM on `auth01` (or `om-dev`) to proxy requests to OpenRouter.

## 1. Install LiteLLM
```bash
sudo pip3 install litellm
```

## 2. Configure Environment
Create the environment file:
```bash
sudo mkdir -p /etc/litellm
sudo nano /etc/litellm/litellm.env
```
Add your OpenRouter API key:
```env
OPENROUTER_API_KEY=sk-or-v1-...
```
Secure the file:
```bash
sudo chmod 600 /etc/litellm/litellm.env
```

## 3. Deploy Configuration
Copy the `config.yaml` file to `/etc/litellm/`:
```bash
sudo cp deploy/litellm/config.yaml /etc/litellm/config.yaml
```

## 4. Install Systemd Service
Copy the service file and start LiteLLM:
```bash
sudo cp deploy/litellm/litellm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable litellm
sudo systemctl start litellm
sudo systemctl status litellm
```

## 5. Update Brain Configuration
Update `/etc/om-brain/om-brain.env` on `om-dev` to point to the new proxy:
```env
BRAIN_LLM_BASE_URL=http://127.0.0.1:4000
BRAIN_LLM_MODEL_REASONING=brain-reasoning
BRAIN_LLM_MODEL_CLASSIFIER=brain-classifier
```
Restart the Brain:
```bash
sudo systemctl restart om-brain
```
