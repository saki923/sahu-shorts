/* global process */
// Vercel serverless function: wake the Sahu Shorts backend.
//
// The backend lives on a GitHub Codespace ("studious succotash") that stops
// after ~30 min idle, so the site can't reach it until it is started again.
// This endpoint (a) reports when the backend is already up, and (b) starts
// the Codespace via the GitHub API when it is down. It answers FAST — it
// never waits for the Codespace to finish starting; the browser polls the
// backend /health endpoint until it answers. The Codespace's
// postStartCommand (see sahu-clip .devcontainer/start-all.sh) starts the
// backend, the dashboard and the PO-token server on every start, and makes
// ports 8000/5175 public.
//
// Required env var (Vercel dashboard -> Settings -> Environment Variables):
//   GH_CODESPACES_TOKEN — fine-grained personal access token with the
//   Codespaces "Read and write" account permission and repository access to
//   saki923/sahu-clip (the repository the Codespace belongs to).
//
// Optional env vars (defaults shown):
//   SAHU_BACKEND_URL    — backend base URL (falls back to VITE_API_URL).
//   SAHU_CODESPACE_NAME — default 'studious succotash'.

const GH_API = 'https://api.github.com';

// Env is read per request, not at module load, so a changed Vercel env var
// applies without a code change.
function config() {
  return {
    backendUrl: (process.env.SAHU_BACKEND_URL || process.env.VITE_API_URL || '').replace(/\/$/, ''),
    codespaceName: process.env.SAHU_CODESPACE_NAME || 'studious succotash',
    ghToken: process.env.GH_CODESPACES_TOKEN || '',
  };
}

async function backendUp(backendUrl) {
  if (!backendUrl) return false;
  try {
    const res = await fetch(`${backendUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body?.status === 'ok';
  } catch (_) {
    return false;
  }
}

async function gh(ghToken, path, method = 'GET') {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text().catch(() => '');
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    // Non-JSON answer; status code is what matters.
  }
  return { status: res.status, body };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: 'error', error: 'method_not_allowed' });
  }

  const { backendUrl, codespaceName, ghToken } = config();

  if (await backendUp(backendUrl)) {
    return res.status(200).json({ status: 'ready' });
  }

  if (!ghToken) {
    // No token configured: the browser still polls /health, because the
    // backend may already be starting (e.g. someone started it by hand).
    return res.status(200).json({ status: 'down', error: 'no_token_configured' });
  }

  try {
    const current = await gh(ghToken, `/user/codespaces/${encodeURIComponent(codespaceName)}`);
    const state = current.body?.state || 'unknown';

    if (state === 'Available') {
      // Codespace is up but the backend isn't answering yet (services still
      // starting): nothing to start, the browser keeps polling /health.
      return res.status(200).json({ status: 'starting', state });
    }
    if (state === 'Starting') {
      return res.status(200).json({ status: 'starting', state });
    }
    if (state === 'Shutdown' || state === 'Stopped') {
      const started = await gh(ghToken, `/user/codespaces/${encodeURIComponent(codespaceName)}/start`, 'POST');
      if (started.status === 200 || started.status === 202) {
        return res.status(200).json({ status: 'starting', state: 'Starting' });
      }
      return res.status(200).json({
        status: 'down',
        error: 'start_failed',
        detail: started.body?.message || `github_${started.status}`,
      });
    }
    // Any other state (Stopping, Failed, Unknown, ...): don't guess, just
    // report it and let the browser's /health poll decide.
    return res.status(200).json({ status: 'starting', state });
  } catch (e) {
    return res.status(200).json({
      status: 'down',
      error: 'wake_failed',
      detail: String(e?.message || e).slice(0, 200),
    });
  }
}
