# Sahu Shorts CLI

Clip long videos into vertical 9:16 shorts from the terminal. Zero
dependencies; talks to the same API the dashboard, the MCP server and the
webhooks use.

```bash
pip install sahu-shorts        # or: uvx sahu-shorts / pipx run sahu-shorts

export SAHU_SHORTS_API_KEY=ssk_...   # optional: self-hosted instances need no key

sahu-shorts process "https://youtube.com/watch?v=..." --wait
sahu-shorts clips <job_id>
sahu-shorts publish <job_id> 0 --platforms tiktok,youtube
sahu-shorts quota
```

Self-hosted instance? Point it at your own machine and skip the key:

```bash
export SAHU_SHORTS_API_URL=http://localhost:8000
sahu-shorts process "https://youtube.com/watch?v=..." --wait
```

For pipelines, prefer the webhook to `--wait`: pass `--webhook` and
`--webhook-secret` and Sahu Shorts POSTs once (HMAC-signed,
`X-OpenShorts-Signature: sha256=<hex>`) when the job ends, with clip titles
and durable download links.

The hosted free tier is 20 minutes/month with a watermark; paid plans from
$12/month. The self-hosted edition is MIT and has no meter. Agent-native
version of the same surface: [github.com/saki923/sahu-shorts/mcp](https://github.com/saki923/sahu-shorts/mcp).
