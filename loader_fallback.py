"""Loader.to fallback downloader for OpenShorts (stdlib only).

Mirrors the public web flow Loader.to's own frontend uses, so it works
where anonymous yt-dlp is bot-walled (e.g. a GitHub Codespace IP):

1. GET https://p.savenow.to/api/v2/download?format=<fmt>&url=<youtube url>
   &apikey=<frontend key> with ``Referer: https://en.loader.to/4/`` and a
   browser User-Agent. Without that Referer the API answers 403
   api_key_required. Fallback host if the primary fails: p.lbserver.xyz,
   same paths.
2. The response JSON is ``{success, id, progress_url}``. Poll
   ``progress_url`` (same Referer header) every few seconds until
   ``success == 1`` AND ``download_url`` is present. ``progress`` runs
   0..1000; ``progress >= 1000`` with no ``download_url`` means that
   format failed — try the next one.
3. Stream the file from ``download_url``, resuming a partial file with an
   HTTP Range request.

Formats are tried in order 1080 -> 720 -> 360. The single public entry
point, :func:`download_via_loader`, never raises: every failure is
reported in the returned dict.

This is a FALLBACK, not a replacement: callers should try yt-dlp first
and only call this after yt-dlp has failed for the video. See
LOADER_FALLBACK_PATCH.md for the exact insertion point in main.py.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

__all__ = ["download_via_loader", "LOADER_FORMATS"]

# The API key Loader.to's own web frontend sends with every conversion
# request; it is public (visible in the page's network traffic), not a
# private credential.
LOADER_API_HOSTS = ("p.savenow.to", "p.lbserver.xyz")
LOADER_API_KEY = "dfcb6d76f2f6a9894gjkege8a4ab232222"
LOADER_REFERER = "https://en.loader.to/4/"
LOADER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
LOADER_FORMATS = ("1080", "720", "360")
# A conversion that has not finished within this long is treated as failed
# for that format (the overall budget in download_via_loader still wins).
LOADER_MAX_WAIT = 1200  # seconds


def _get_json(url, timeout=30):
    """GET a Loader.to API URL and decode its JSON body."""
    req = urllib.request.Request(url, headers={
        "Referer": LOADER_REFERER, "User-Agent": LOADER_UA,
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _start(youtube_url, fmt):
    """Start a conversion. Returns (id, progress_url) or None."""
    query = urllib.parse.urlencode({
        "format": fmt, "url": youtube_url, "apikey": LOADER_API_KEY,
    })
    for host in LOADER_API_HOSTS:
        try:
            data = _get_json("https://%s/api/v2/download?%s" % (host, query),
                             timeout=60)
        except Exception:  # noqa: BLE001 - try the next host
            continue
        if data.get("success") and data.get("id"):
            progress_url = data.get("progress_url") or (
                "https://%s/api/progress?id=%s" % (host, data["id"]))
            return data["id"], progress_url
    return None


def _poll(progress_url, started, deadline, poll_interval=5.0):
    """Poll one conversion until it yields a download URL.

    Returns the download URL string, or None when this format failed
    (progress reached 1000 with no URL, conversion timed out, or the
    overall deadline ran out).
    """
    while True:
        now = time.time()
        if now > deadline or now > started + LOADER_MAX_WAIT:
            return None
        try:
            data = _get_json(progress_url, timeout=30)
        except Exception:  # noqa: BLE001 - poll again next round
            data = {}
        if data.get("success") == 1 and data.get("download_url"):
            return data["download_url"]
        if data.get("progress", 0) >= 1000 and not data.get("download_url"):
            return None
        time.sleep(poll_interval)


def _fetch(download_url, dest_path, deadline):
    """Stream the converted file to dest_path (Range-resumable).

    Returns True when the file is complete, False when the deadline ran
    out mid-download (the partial file stays on disk and a later call
    resumes it). Raises on network/HTTP errors so the caller can report
    them.
    """
    size = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
    headers = {"Referer": LOADER_REFERER, "User-Agent": LOADER_UA}
    if size:
        headers["Range"] = "bytes=%d-" % size
    req = urllib.request.Request(download_url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status == 416:  # already complete
            return True
        mode = "ab" if resp.status == 206 else "wb"
        with open(dest_path, mode) as f:
            while True:
                if time.time() > deadline:
                    return False
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    return True


def download_via_loader(youtube_url, dest_path, budget_seconds=1200,
                        poll_interval=5.0):
    """Download a YouTube video via Loader.to's public web flow.

    Tries formats 1080 -> 720 -> 360, starting a conversion for each and
    polling until it finishes, then streaming the file to ``dest_path``
    (resuming a partial file already there).

    Returns a dict, never raises::

        {"ok": True,  "path": dest_path, "height_hint": 1080, "error": None}
        {"ok": False, "path": None, "height_hint": None,
         "error": "Loader.to failed for formats 1080, 720, 360: ..."}

    ``height_hint`` is the requested format height of the file that was
    fetched (Loader.to converts to that height); verify the real
    dimensions with ffprobe if they matter.
    """
    deadline = time.time() + budget_seconds
    errors = []
    try:
        parent = os.path.dirname(os.path.abspath(dest_path))
        os.makedirs(parent, exist_ok=True)
        for fmt in LOADER_FORMATS:
            if time.time() > deadline:
                errors.append("budget of %ss exhausted" % budget_seconds)
                break
            started_conversion = _start(youtube_url, fmt)
            if not started_conversion:
                errors.append("format %s: conversion did not start" % fmt)
                continue
            _conv_id, progress_url = started_conversion
            download_url = _poll(progress_url, time.time(), deadline,
                                 poll_interval=poll_interval)
            if not download_url:
                errors.append("format %s: conversion failed or timed out"
                              % fmt)
                continue
            try:
                complete = _fetch(download_url, dest_path, deadline)
            except urllib.error.HTTPError as e:
                errors.append("format %s: file fetch HTTP %s" % (fmt, e.code))
                continue
            except Exception as e:  # noqa: BLE001 - report, try next format
                errors.append("format %s: file fetch failed: %s" % (fmt, e))
                continue
            if not complete:
                errors.append("format %s: download ran out of budget" % fmt)
                continue
            if os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
                return {"ok": True, "path": dest_path,
                        "height_hint": int(fmt), "error": None}
            errors.append("format %s: fetched file is empty" % fmt)
    except Exception as e:  # noqa: BLE001 - this function never raises
        errors.append("unexpected error: %s" % e)
    return {"ok": False, "path": None, "height_hint": None,
            "error": "Loader.to failed for formats %s: %s"
                     % (", ".join(LOADER_FORMATS), "; ".join(errors))}
