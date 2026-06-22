#!/usr/bin/env python3
"""
Small localhost HTTP service for Four.meme frontend fetches.

The service keeps one Scrapling StealthySession alive and limits concurrent page
work so the Node monitor can keep its 10s scheduler without spawning a browser
per URL.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import TimeoutError as FutureTimeoutError
import json
import os
import secrets
import signal
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any
from urllib.parse import urljoin, urlparse

CHALLENGE_RE = (
    "cf-ray",
    "cf-chl",
    "/cdn-cgi/challenge-platform",
    "challenge-platform",
    "checking your browser",
    "verify you are human",
    "<title>just a moment",
    "<title>attention required",
    "cloudflare ray id",
    "cf-error-code",
    "enable javascript and cookies to continue",
)


def read_int(name: str, fallback: int) -> int:
    try:
        value = int(os.getenv(name, "").strip())
        return value if value > 0 else fallback
    except ValueError:
        return fallback


def read_bool(name: str, fallback: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return fallback
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def load_env_files() -> None:
    script_dir = Path(__file__).resolve().parent
    for env_path in (script_dir / ".env", script_dir.parent / ".env", Path.cwd() / ".env"):
        if not env_path.exists():
            continue
        try:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("\"'")
                if key and key not in os.environ:
                    os.environ[key] = value
        except OSError:
            continue


load_env_files()


HOST = os.getenv("FOURMEME_SCRAPLING_HOST", "127.0.0.1")
PORT = read_int("FOURMEME_SCRAPLING_PORT", 8787)
MAX_PAGES = read_int("FOURMEME_SCRAPLING_MAX_PAGES", 4)
PAGE_TIMEOUT_MS = read_int("FOURMEME_SCRAPLING_PAGE_TIMEOUT_MS", 60_000)
WAIT_MS = read_int("FOURMEME_SCRAPLING_WAIT_MS", 0)
FETCH_TOTAL_TIMEOUT_MS = read_int("FOURMEME_SCRAPLING_FETCH_TOTAL_TIMEOUT_MS", PAGE_TIMEOUT_MS + 5_000)
FETCH_WITH_ASSETS_TOTAL_TIMEOUT_MS = read_int("FOURMEME_SCRAPLING_FETCH_WITH_ASSETS_TOTAL_TIMEOUT_MS", PAGE_TIMEOUT_MS + 15_000)
MAX_ASSETS = read_int("FOURMEME_SCRAPLING_MAX_ASSETS", 20)
MAX_ASSET_BYTES = read_int("FOURMEME_SCRAPLING_MAX_ASSET_BYTES", 1_000_000)
MAX_ASSET_TOTAL_BYTES = read_int("FOURMEME_SCRAPLING_MAX_ASSET_TOTAL_BYTES", 6_000_000)
ASSET_TIMEOUT_MS = read_int("FOURMEME_SCRAPLING_ASSET_TIMEOUT_MS", 8_000)
ASSET_TOTAL_TIMEOUT_MS = read_int("FOURMEME_SCRAPLING_ASSET_TOTAL_TIMEOUT_MS", 15_000)
ASSET_CONCURRENCY = read_int("FOURMEME_SCRAPLING_ASSET_CONCURRENCY", 4)
WARMUP_TIMEOUT_MS = read_int("FOURMEME_SCRAPLING_WARMUP_TIMEOUT_MS", 90_000)
HEADLESS = read_bool("FOURMEME_SCRAPLING_HEADLESS", True)
SOLVE_CLOUDFLARE = read_bool("FOURMEME_SCRAPLING_SOLVE_CLOUDFLARE", True)
NETWORK_IDLE = read_bool("FOURMEME_SCRAPLING_WAIT_NETWORK_IDLE", False)
DISABLE_RESOURCES = read_bool("FOURMEME_SCRAPLING_DISABLE_RESOURCES", False)
PROXY = os.getenv("FOURMEME_SCRAPLING_PROXY", "").strip() or None
WARMUP_URL = os.getenv("FOURMEME_SCRAPLING_WARMUP_URL", "https://four.meme/en").strip()
FETCH_TOKEN = os.getenv("FOURMEME_SCRAPLING_TOKEN", "").strip()
ALLOWED_HOSTS = tuple(
    h.strip().lower()
    for h in os.getenv("FOURMEME_SCRAPLING_ALLOWED_HOSTS", "four.meme,*.four.meme").split(",")
    if h.strip()
)


def is_loopback_bind(host: str) -> bool:
    return host in {"127.0.0.1", "localhost", "::1"}


if not is_loopback_bind(HOST) and not FETCH_TOKEN:
    raise RuntimeError("FOURMEME_SCRAPLING_TOKEN is required when binding the fetcher outside localhost")


def is_challenge(text: str) -> bool:
    low = (text or "").lower()
    if "/_next/static/" in low and not any(token in low for token in ("cf-ray", "cf-chl", "/cdn-cgi/challenge-platform")):
        return False
    return any(token in low for token in CHALLENGE_RE)


def host_allowed(hostname: str | None) -> bool:
    host = (hostname or "").lower().strip(".")
    if not host:
        return False
    for pattern in ALLOWED_HOSTS:
        if pattern.startswith("*.") and host.endswith(pattern[1:]):
            return True
        if host == pattern:
            return True
    return False


def validate_fetch_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Invalid url")
    if parsed.username or parsed.password:
        raise ValueError("URL credentials are not allowed")
    if not host_allowed(parsed.hostname):
        raise PermissionError(f"Host is not allowed: {parsed.hostname}")
    return url


def response_text(response: Any) -> str:
    body = getattr(response, "body", None)
    if isinstance(body, bytes):
        return body.decode("utf-8", errors="replace")
    if isinstance(body, str):
        return body
    text = getattr(response, "text", None)
    if isinstance(text, str):
        return text
    if text is not None:
        try:
            return str(text)
        except Exception:
            pass
    html = getattr(response, "html", None)
    if isinstance(html, str):
        return html
    return str(response)


def json_bytes(payload: dict[str, Any], status: int = 200) -> tuple[int, bytes]:
    return status, json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class FetcherRuntime:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = Thread(target=self._run_loop, name="scrapling-fetcher-loop", daemon=True)
        self.ready = asyncio.Event()
        self.session = None
        self.sem: asyncio.Semaphore | None = None
        self.started_at = time.time()
        self.warmup_started_at = 0.0
        self.warmup_finished_at = 0.0
        self.warmup_ok = False
        self.warmup_error = ""

    def start(self) -> None:
        self.thread.start()
        fut = asyncio.run_coroutine_threadsafe(self._init(), self.loop)
        fut.result(timeout=90)

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    async def _init(self) -> None:
        try:
            from scrapling.fetchers import AsyncStealthySession
        except Exception as exc:  # pragma: no cover - depends on deployment env
            raise RuntimeError(
                "Scrapling is not installed. Run: python -m pip install -r fourmeme-fetcher-service/requirements.txt"
            ) from exc

        self.sem = asyncio.Semaphore(MAX_PAGES)
        self.session = AsyncStealthySession(
            headless=HEADLESS,
            max_pages=MAX_PAGES,
            network_idle=NETWORK_IDLE,
            disable_resources=DISABLE_RESOURCES,
            solve_cloudflare=SOLVE_CLOUDFLARE,
            proxy=PROXY,
            timeout=PAGE_TIMEOUT_MS,
            wait=WAIT_MS,
        )
        await self.session.start()
        self.ready.set()
        if WARMUP_URL:
            self.loop.create_task(self._warmup())

    async def _warmup(self) -> None:
        self.warmup_started_at = time.time()
        try:
            await self.fetch({"url": WARMUP_URL, "includeAssets": False}, timeout_ms=WARMUP_TIMEOUT_MS)
            self.warmup_ok = True
            self.warmup_error = ""
        except Exception as exc:
            self.warmup_ok = False
            self.warmup_error = str(exc)
        finally:
            self.warmup_finished_at = time.time()

    async def close(self) -> None:
        session = self.session
        self.session = None
        if session is not None:
            close = getattr(session, "close", None)
            if close:
                result = close()
                if asyncio.iscoroutine(result):
                    await result

    def stop(self) -> None:
        fut = asyncio.run_coroutine_threadsafe(self.close(), self.loop)
        try:
            fut.result(timeout=15)
        finally:
            self.loop.call_soon_threadsafe(self.loop.stop)

    def run_fetch(self, payload: dict[str, Any]) -> dict[str, Any]:
        include_assets = bool(payload.get("includeAssets"))
        total_timeout_ms = FETCH_WITH_ASSETS_TOTAL_TIMEOUT_MS if include_assets else FETCH_TOTAL_TIMEOUT_MS
        fut = asyncio.run_coroutine_threadsafe(
            asyncio.wait_for(self.fetch(payload), timeout=total_timeout_ms / 1000),
            self.loop,
        )
        try:
            return fut.result(timeout=(total_timeout_ms / 1000) + 2)
        except FutureTimeoutError:
            fut.cancel()
            raise TimeoutError(f"Fetch total timeout {total_timeout_ms}ms")

    async def fetch(self, payload: dict[str, Any], timeout_ms: int = PAGE_TIMEOUT_MS) -> dict[str, Any]:
        await self.ready.wait()
        if self.session is None or self.sem is None:
            raise RuntimeError("Scrapling session is not ready")

        url = validate_fetch_url(str(payload.get("url") or ""))
        include_assets = bool(payload.get("includeAssets"))

        started = time.time()
        async with self.sem:
            page = await self.session.fetch(url, timeout=timeout_ms)
            html = response_text(page)
            status = int(getattr(page, "status", 200) or 200)
            result: dict[str, Any] = {
                "html": html,
                "assets": {},
                "status": status,
                "source": "scrapling_stealthy",
                "durationMs": int((time.time() - started) * 1000),
                "challenge": is_challenge(html),
            }
            if include_assets and html:
                result["assets"] = await self._fetch_assets(url, html)
                result["assetCount"] = len(result["assets"])
            return result

    async def _fetch_assets(self, base_url: str, html: str) -> dict[str, dict[str, Any]]:
        from html.parser import HTMLParser

        class AssetParser(HTMLParser):
            def __init__(self) -> None:
                super().__init__()
                self.urls: list[str] = []

            def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
                data = dict(attrs)
                if tag == "script" and data.get("src"):
                    self.urls.append(urljoin(base_url, data["src"] or ""))
                elif tag == "link" and data.get("href") and (data.get("rel") or "").lower() == "stylesheet":
                    self.urls.append(urljoin(base_url, data["href"] or ""))

        parser = AssetParser()
        parser.feed(html)
        urls: list[str] = []
        seen: set[str] = set()
        for asset_url in parser.urls:
            path = urlparse(asset_url).path
            if "/_next/static/" not in path or not path.endswith((".js", ".css")):
                continue
            if not host_allowed(urlparse(asset_url).hostname):
                continue
            if asset_url in seen:
                continue
            seen.add(asset_url)
            urls.append(asset_url)
            if len(urls) >= MAX_ASSETS:
                break

        out: dict[str, dict[str, Any]] = {}
        asset_sem = asyncio.Semaphore(max(1, ASSET_CONCURRENCY))
        total_bytes = 0
        total_lock = asyncio.Lock()

        async def fetch_one(asset_url: str) -> tuple[str, dict[str, Any]] | None:
            nonlocal total_bytes
            try:
                async with asset_sem:
                    page = await self.session.fetch(asset_url, timeout=ASSET_TIMEOUT_MS, solve_cloudflare=False)
                content = response_text(page)
                content_bytes = len(content.encode("utf-8", errors="ignore"))
                truncated = content_bytes > MAX_ASSET_BYTES
                if truncated:
                    content = content[:MAX_ASSET_BYTES]
                    content_bytes = len(content.encode("utf-8", errors="ignore"))
                async with total_lock:
                    if total_bytes >= MAX_ASSET_TOTAL_BYTES:
                        return None
                    remaining = MAX_ASSET_TOTAL_BYTES - total_bytes
                    if content_bytes > remaining:
                        content = content.encode("utf-8", errors="ignore")[:remaining].decode("utf-8", errors="ignore")
                        content_bytes = len(content.encode("utf-8", errors="ignore"))
                        truncated = True
                    total_bytes += content_bytes
                return urlparse(asset_url).path, {
                    "url": asset_url,
                    "content": content,
                    "truncated": truncated,
                }
            except Exception:
                return None

        tasks = [asyncio.create_task(fetch_one(asset_url)) for asset_url in urls]
        try:
            results = await asyncio.wait_for(asyncio.gather(*tasks), timeout=ASSET_TOTAL_TIMEOUT_MS / 1000)
        except asyncio.TimeoutError:
            for task in tasks:
                task.cancel()
            results = [task.result() for task in tasks if task.done() and not task.cancelled() and task.exception() is None]
        for item in results:
            if item is None:
                continue
            key, value = item
            out[key] = value
        return out


runtime = FetcherRuntime()


class Handler(BaseHTTPRequestHandler):
    server_version = "FourMemeScraplingFetcher/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), fmt % args))

    def _send(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not FETCH_TOKEN:
            return True
        return secrets.compare_digest(self.headers.get("X-Fourmeme-Fetcher-Token", ""), FETCH_TOKEN)

    def do_GET(self) -> None:
        if self.path != "/health":
            status, body = json_bytes({"ok": False, "error": "not_found"}, HTTPStatus.NOT_FOUND)
            self._send(status, body)
            return
        status, body = json_bytes({
            "ok": True,
            "source": "scrapling_stealthy",
            "uptimeSec": int(time.time() - runtime.started_at),
            "maxPages": MAX_PAGES,
            "headless": HEADLESS,
            "solveCloudflare": SOLVE_CLOUDFLARE,
            "networkIdle": NETWORK_IDLE,
            "disableResources": DISABLE_RESOURCES,
            "allowedHosts": ALLOWED_HOSTS,
            "requiresToken": bool(FETCH_TOKEN),
            "assetMax": MAX_ASSETS,
            "assetConcurrency": ASSET_CONCURRENCY,
            "assetTotalTimeoutMs": ASSET_TOTAL_TIMEOUT_MS,
            "assetMaxTotalBytes": MAX_ASSET_TOTAL_BYTES,
            "warmupUrl": WARMUP_URL,
            "warmupOk": runtime.warmup_ok,
            "warmupRunning": runtime.warmup_started_at > 0 and runtime.warmup_finished_at == 0,
            "warmupFinished": runtime.warmup_finished_at > 0,
            "warmupError": runtime.warmup_error,
        })
        self._send(status, body)

    def do_POST(self) -> None:
        if self.path != "/fetch":
            status, body = json_bytes({"ok": False, "error": "not_found"}, HTTPStatus.NOT_FOUND)
            self._send(status, body)
            return
        try:
            if not self._authorized():
                status, body = json_bytes({"ok": False, "error": "unauthorized"}, HTTPStatus.UNAUTHORIZED)
                self._send(status, body)
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 512_000:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            result = runtime.run_fetch(payload)
            status, body = json_bytes({"ok": True, **result})
            self._send(status, body)
        except PermissionError as exc:
            status, body = json_bytes({
                "ok": False,
                "error": type(exc).__name__,
                "message": str(exc),
            }, HTTPStatus.FORBIDDEN)
            self._send(status, body)
        except (ValueError, json.JSONDecodeError) as exc:
            status, body = json_bytes({
                "ok": False,
                "error": type(exc).__name__,
                "message": str(exc),
            }, HTTPStatus.BAD_REQUEST)
            self._send(status, body)
        except TimeoutError as exc:
            status, body = json_bytes({
                "ok": False,
                "error": type(exc).__name__,
                "message": str(exc),
            }, HTTPStatus.GATEWAY_TIMEOUT)
            self._send(status, body)
        except Exception as exc:
            status, body = json_bytes({
                "ok": False,
                "error": type(exc).__name__,
                "message": str(exc),
            }, HTTPStatus.INTERNAL_SERVER_ERROR)
            self._send(status, body)


def main() -> None:
    runtime.start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)

    def shutdown(*_: Any) -> None:
        Thread(target=server.shutdown, name="scrapling-fetcher-shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(f"fourmeme scrapling fetcher listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    finally:
        runtime.stop()
        server.server_close()


if __name__ == "__main__":
    main()
