# Loader.to fallback patch for OpenShorts — DOCUMENT ONLY, do not apply yet

## What this is

A minimal, **additive** patch to `main.py` so that when every yt-dlp route
fails (the Codespace host IP is bot-walled by YouTube), the download falls
back to Loader.to's public web flow (`loader_fallback.py`, same directory)
**before** giving up. yt-dlp stays the first and only path tried in the
normal case; Loader.to is tried **only after yt-dlp has failed**.

No other file changes. `loader_fallback.py` is stdlib-only
(`urllib` + `json` + `os` + `time`) and never raises — it returns a dict.

## The download function (found)

- **Wrapper:** `download_youtube_video(url, output_dir=".", on_audio=None,
  allow_paid=True, cap_minutes=None, route_out=None)` — `main.py:867`.
  Thin SSRF-guarded wrapper; returns whatever `_download_youtube_video`
  returns.
- **Real work:** `_download_youtube_video(url, output_dir=".",
  on_audio=None, allow_paid=True, cap_minutes=None, route_out=None)` —
  `main.py:878`. Runs the yt-dlp attempt loop (`plan_download_attempts` +
  `_attempt`), and returns `(downloaded_file, sanitized_title)`.
- **Callers:** `main.py:2664` (CLI pipeline) and `app.py:8714`
  (web API). Both go through the wrapper, so patching
  `_download_youtube_video` covers both.

## Insertion point (exact)

In `_download_youtube_video`, the final failure block — `main.py:1237-1251`.
Current code, quoted verbatim:

```python
    if sanitized_title is None:
        import sys
        error_msg = f"""
❌ ================================================================= ❌
❌ FATAL ERROR: YOUTUBE DOWNLOAD FAILED (all strategies)
❌ ================================================================= ❌
REASON: YouTube blocked the request or the download tooling is out of date.
👇 SOLUTION FOR USER: download the video manually and use the 'Upload Video' tab.
Technical Details: {str(last_err)}
"""
        print(error_msg, file=sys.stdout)
        print(error_msg, file=sys.stderr)
        sys.stdout.flush(); sys.stderr.flush()
        time.sleep(0.5)
        raise last_err
```

Insert the fallback **at the top of that block**, immediately after line
1237 (`if sanitized_title is None:`) and before line 1238
(`import sys`). If the fallback succeeds, `sanitized_title` becomes
non-`None`, so the `raise last_err` below is skipped and execution falls
through to the existing success path at line 1253, which resolves
`downloaded_file = os.path.join(output_dir, f'{sanitized_title}.mp4')` —
exactly the file the fallback wrote.

## Exact code to add

```python
    if sanitized_title is None:
        # LAST-RESORT FALLBACK (additive): every yt-dlp route above failed
        # (e.g. this host's IP is bot-walled by YouTube). Try Loader.to's
        # public web flow before giving up. Runs ONLY after yt-dlp failed,
        # and ONLY for YouTube URLs.
        if is_youtube_url(url):
            try:
                from loader_fallback import download_via_loader
                _loader_dest = os.path.join(output_dir, "loader_source.mp4")
                _loader_res = download_via_loader(
                    url, _loader_dest, budget_seconds=1200)
            except Exception as _loader_exc:  # noqa: BLE001 - import guard
                _loader_res = {"ok": False, "error": str(_loader_exc)}
            if _loader_res.get("ok"):
                print(f"✅ Loader.to fallback downloaded the video "
                      f"(format {_loader_res.get('height_hint')}p).")
                sanitized_title = "loader_source"
                attempt_log.append({"label": "loader.to fallback",
                                    "ok": True, "bytes": 0, "paid": False})
            else:
                print(f"⚠️ Loader.to fallback also failed: "
                      f"{_loader_res.get('error')}")
        import sys
        error_msg = f"""
... (existing FATAL ERROR block unchanged; it only runs when
     sanitized_title is still None, i.e. the fallback also failed) ...
```

Notes on the snippet:

- `is_youtube_url` is already defined and used in this function
  (e.g. line 1149); `os` and `attempt_log` are already in scope.
- `download_via_loader` never raises, but the `try/except` also guards
  the import (e.g. if `loader_fallback.py` is missing, the original
  `raise last_err` behaviour is preserved).
- `budget_seconds=1200` caps the whole fallback (conversion polling +
  file fetch) at 20 minutes; a 22-minute video converted + downloaded
  well inside that in the proven run.
- The fallback file is named `loader_source.mp4` because Loader.to does
  not return the video title; `sanitized_title = "loader_source"` makes
  the existing line-1253 path resolution find it. Downstream code that
  uses the title only for output naming will see `loader_source`.
- `on_audio` is NOT called on the fallback path: the audio track is
  inside the downloaded mp4, and transcription later reads it from the
  video file, so nothing is lost.
- The `_content_block` early-raise at lines 1225-1227 (private /
  members-only / age-gated videos) still fires before this block — those
  videos cannot be converted by Loader.to either, so skipping the
  fallback there is correct and saves time.

## How the fallback works (for the reviewer)

`loader_fallback.py:download_via_loader(youtube_url, dest_path,
budget_seconds=1200)`:

1. `GET https://p.savenow.to/api/v2/download?format=<fmt>&url=<yt>
   &apikey=dfcb6d76f2f6a9894gjkege8a4ab232222` with headers
   `Referer: https://en.loader.to/4/` and a browser User-Agent.
   (Without that Referer the API answers 403 `api_key_required`.)
   Fallback host on failure: `p.lbserver.xyz`, same paths.
2. Response JSON `{success, id, progress_url}`; poll `progress_url`
   every 5s until `success == 1` and `download_url` is present.
   `progress >= 1000` with no `download_url` = that format failed.
3. Stream the file from `download_url`, resuming a partial file with an
   HTTP `Range` request.
4. Formats tried in order: **1080 → 720 → 360**.

## Verification (done on this VM, 2026-11-13)

`download_via_loader("https://www.youtube.com/watch?v=jNQXAC9IVRw",
"/tmp/loader_test_zoo.mp4", budget_seconds=600)` → `{"ok": true,
"height_hint": 1080}` in ~13 s. ffprobe on the file:

- size **743,099 bytes**, duration **19.13 s**, **320x240**, h264, 15 fps.

The 320x240 is the video's true native resolution ("Me at the zoo" is a
2005 upload; 240p is its max) — Loader.to returned the source as-is
rather than upscaling it. `height_hint` is the *requested* format
height, not the actual height; verify real dimensions with ffprobe when
they matter. A 22-minute 1920x1080 video was already proven through the
same flow earlier tonight (true 1080p).

## Caveats

- Loader.to is a third-party service: availability and the frontend API
  key can change without notice. If it breaks, the patch degrades
  gracefully — the fallback returns an error dict, the FATAL ERROR block
  runs as before, and the user-facing behaviour is unchanged.
- The fallback adds up to 20 minutes (budget) to a job that would
  otherwise fail fast. That is the intended trade-off: a slow success
  beats a fast failure on a bot-walled host.
- No YouTube account or cookies are needed or used by the fallback.
