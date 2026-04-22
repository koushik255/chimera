import asyncio
import contextlib
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import monotonic
from typing import Any, Callable
from urllib.parse import urlparse

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from scanner import scan_series

CONFIG_PATH = Path(__file__).with_name("config.json")
FRONTEND_DIR = Path(__file__).with_name("frontend")
DEFAULT_MEMORY_INTERVAL_SECONDS = 60.0
DEFAULT_INITIAL_RECONNECT_DELAY_SECONDS = 1
DEFAULT_MAX_RECONNECT_DELAY_SECONDS = 300
DEFAULT_IDLE_POLL_INTERVAL_SECONDS = 15.0
DEFAULT_FRONT_HOST = "127.0.0.1"
DEFAULT_FRONT_PORT = 1573


@dataclass(frozen=True)
class HostConfig:
    ws_url: str
    series_paths: list[Path]
    host_id: str
    host_username: str
    front_host: str
    front_port: int
    monitor_memory: bool
    memory_interval_seconds: float
    cache_bytes: int
    cache_pages: int
    max_cacheable_page_bytes: int
    idle_after_seconds: float
    initial_reconnect_delay_seconds: float
    max_reconnect_delay_seconds: float


@dataclass
class HostManifestSummary:
    series: list[dict[str, Any]]
    total_series: int
    total_volumes: int
    total_pages: int

    def snapshot(self) -> dict[str, Any]:
        return {
            "series": self.series,
            "totalSeries": self.total_series,
            "totalVolumes": self.total_volumes,
            "totalPages": self.total_pages,
        }


class PageByteCache:
    def __init__(self, max_bytes: int, max_entries: int, max_cacheable_page_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.max_cacheable_page_bytes = max_cacheable_page_bytes
        self.entries: OrderedDict[str, bytes] = OrderedDict()
        self.total_bytes = 0
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.lock = asyncio.Lock()

    async def get(self, page_id: str) -> bytes | None:
        if self.max_bytes <= 0 or self.max_entries <= 0:
            self.misses += 1
            return None

        async with self.lock:
            page_bytes = self.entries.get(page_id)
            if page_bytes is None:
                self.misses += 1
                return None

            self.entries.move_to_end(page_id)
            self.hits += 1
            return page_bytes

    async def put(self, page_id: str, page_bytes: bytes) -> None:
        if self.max_bytes <= 0 or self.max_entries <= 0:
            return

        page_size = len(page_bytes)
        if page_size == 0 or page_size > self.max_bytes or page_size > self.max_cacheable_page_bytes:
            return

        async with self.lock:
            existing = self.entries.pop(page_id, None)
            if existing is not None:
                self.total_bytes -= len(existing)

            self.entries[page_id] = page_bytes
            self.total_bytes += page_size

            while (self.total_bytes > self.max_bytes or len(self.entries) > self.max_entries) and self.entries:
                _, evicted_bytes = self.entries.popitem(last=False)
                self.total_bytes -= len(evicted_bytes)
                self.evictions += 1

    async def clear(self) -> int:
        async with self.lock:
            cleared_bytes = self.total_bytes
            self.entries.clear()
            self.total_bytes = 0
            return cleared_bytes

    async def snapshot(self) -> dict[str, int]:
        async with self.lock:
            return {
                "entries": len(self.entries),
                "total_bytes": self.total_bytes,
                "hits": self.hits,
                "misses": self.misses,
                "evictions": self.evictions,
            }


class HostRuntime:
    def __init__(self, config: HostConfig, page_cache: PageByteCache, logger: Callable[[str], None]) -> None:
        self.config = config
        self.page_cache = page_cache
        self.logger = logger
        self.last_request_at = monotonic()
        self.idle = False
        self.activity_lock = asyncio.Lock()

    async def record_request_activity(self) -> None:
        async with self.activity_lock:
            was_idle = self.idle
            self.last_request_at = monotonic()
            self.idle = False

        if was_idle:
            self.logger("[hoster idle] leaving idle mode because a new request arrived")

    async def maybe_enter_idle_mode(self) -> None:
        if self.config.idle_after_seconds <= 0:
            return

        async with self.activity_lock:
            idle_for_seconds = monotonic() - self.last_request_at
            should_idle = not self.idle and idle_for_seconds >= self.config.idle_after_seconds
            if not should_idle:
                return
            self.idle = True

        cleared_bytes = await self.page_cache.clear()
        self.logger(
            "[hoster idle] entered idle mode after "
            f"{self.config.idle_after_seconds:.0f}s inactivity; cleared_cache_bytes={cleared_bytes}"
        )


@dataclass
class HostStatus:
    frontend_enabled: bool
    frontend_host: str
    frontend_port: int
    on_change: Callable[[dict[str, Any]], None] | None = None
    connected: bool = False
    last_connected_at: str | None = None
    last_disconnected_at: str | None = None
    last_error: str | None = None

    def __post_init__(self) -> None:
        self.lock = threading.Lock()
        self._notify_change()

    def mark_connected(self) -> None:
        with self.lock:
            self.connected = True
            self.last_connected_at = utc_now()
            self.last_error = None
        self._notify_change()

    def mark_disconnected(self, error: str | None = None) -> None:
        with self.lock:
            self.connected = False
            self.last_disconnected_at = utc_now()
            if error:
                self.last_error = error
        self._notify_change()

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "frontendEnabled": self.frontend_enabled,
                "frontendHost": self.frontend_host,
                "frontendPort": self.frontend_port,
                "connected": self.connected,
                "lastConnectedAt": self.last_connected_at,
                "lastDisconnectedAt": self.last_disconnected_at,
                "lastError": self.last_error,
            }

    def _notify_change(self) -> None:
        if self.on_change is not None:
            self.on_change(self.snapshot())


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_host_config(raw: dict[str, Any]) -> HostConfig:
    series_paths = [Path(value) for value in raw["seriesPaths"]]
    front_host = str(raw.get("frontHost", DEFAULT_FRONT_HOST))
    front_port = int(raw.get("frontPort", DEFAULT_FRONT_PORT))
    cache_pages = int(raw.get("cachePages", 1))

    if not front_host:
        raise ValueError("frontHost must not be empty")
    if front_port <= 0 or front_port > 65535:
        raise ValueError("frontPort must be between 1 and 65535")
    if cache_pages < 0:
        raise ValueError("cachePages must be 0 or greater")

    return HostConfig(
        ws_url=raw["wsUrl"],
        series_paths=series_paths,
        host_id=raw["host"]["id"],
        host_username=raw["host"]["username"],
        front_host=front_host,
        front_port=front_port,
        monitor_memory=raw.get("monitorMemory", False),
        memory_interval_seconds=float(raw.get("memoryIntervalSeconds", DEFAULT_MEMORY_INTERVAL_SECONDS)),
        cache_bytes=int(raw.get("cacheBytes", 0)),
        cache_pages=cache_pages,
        max_cacheable_page_bytes=int(raw.get("maxCacheablePageBytes", 0)),
        idle_after_seconds=float(raw.get("idleAfterSeconds", 0)),
        initial_reconnect_delay_seconds=float(
            raw.get("initialReconnectDelaySeconds", DEFAULT_INITIAL_RECONNECT_DELAY_SECONDS)
        ),
        max_reconnect_delay_seconds=float(
            raw.get("maxReconnectDelaySeconds", DEFAULT_MAX_RECONNECT_DELAY_SECONDS)
        ),
    )


def load_config(config_path: Path = CONFIG_PATH) -> HostConfig:
    raw = load_config_json(config_path)
    return parse_host_config(raw)


def load_config_json(config_path: Path = CONFIG_PATH) -> dict[str, Any]:
    return json.loads(config_path.read_text(encoding="utf-8"))


def save_config_json(raw: dict[str, Any], config_path: Path = CONFIG_PATH) -> None:
    parse_host_config(raw)
    config_path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")


def build_manifest_payload(
    config: HostConfig,
) -> tuple[dict[str, Any], dict[str, Path], dict[str, dict[str, Any]], HostManifestSummary]:
    manifest_series_entries: list[dict[str, Any]] = []
    page_lookup: dict[str, Path] = {}
    page_metadata: dict[str, dict[str, Any]] = {}

    for series_path in config.series_paths:
        series = scan_series(series_path)
        manifest_series = {
            "id": series.id,
            "title": series.title,
            "volumes": [],
        }

        for volume in series.volumes:
            manifest_volume = {
                "id": volume.id,
                "seriesId": volume.series_id,
                "title": volume.title,
                "volumeNumber": volume.volume_number,
                "pageCount": len(volume.pages),
                "pages": [],
            }

            for page in volume.pages:
                if page.id in page_lookup:
                    raise ValueError(f"Duplicate page id found while building manifest: {page.id}")

                page_lookup[page.id] = page.file_path
                page_metadata[page.id] = {
                    "id": page.id,
                    "volumeId": page.volume_id,
                    "index": page.index,
                    "fileName": page.file_name,
                    "contentType": page.content_type,
                    "fileSize": page.file_size,
                }
                manifest_volume["pages"].append(page_metadata[page.id])

            manifest_series["volumes"].append(manifest_volume)

        manifest_series_entries.append(manifest_series)

    payload = {
        "type": "register_manifest",
        "host": {
            "id": config.host_id,
            "username": config.host_username,
        },
        "series": manifest_series_entries,
    }

    summary = HostManifestSummary(
        series=[
            {
                "title": series["title"],
                "volumeCount": len(series["volumes"]),
                "pageCount": sum(volume["pageCount"] for volume in series["volumes"]),
            }
            for series in manifest_series_entries
        ],
        total_series=len(manifest_series_entries),
        total_volumes=sum(len(series["volumes"]) for series in manifest_series_entries),
        total_pages=len(page_lookup),
    )

    return payload, page_lookup, page_metadata, summary


def make_frontend_handler(
    *,
    config_path: Path,
    status: HostStatus,
) -> type[BaseHTTPRequestHandler]:
    class FrontendHandler(BaseHTTPRequestHandler):
        server_version = "chimera-front/0.1"

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/api/config":
                self._write_json(HTTPStatus.OK, load_config_json(config_path))
                return

            if parsed.path == "/api/status":
                config = load_config(config_path)
                self._write_json(
                    HTTPStatus.OK,
                    {
                        **status.snapshot(),
                        "configPath": str(config_path),
                        "wsUrl": config.ws_url,
                        "seriesPaths": [str(path) for path in config.series_paths],
                        "hostId": config.host_id,
                        "hostUsername": config.host_username,
                    },
                )
                return

            self._serve_static(parsed.path)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path != "/api/config":
                self._write_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return

            try:
                raw_length = self.headers.get("content-length")
                if raw_length is None:
                    raise ValueError("Missing content-length header")

                body = self.rfile.read(int(raw_length))
                payload = json.loads(body.decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("Config payload must be a JSON object")

                save_config_json(payload, config_path)
            except (ValueError, KeyError, TypeError) as exc:
                self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return

            self._write_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "message": "Config saved. Restart the host process to apply connection or port changes.",
                },
            )

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _serve_static(self, route_path: str) -> None:
            relative_path = route_path.lstrip("/") or "index.html"
            if relative_path.endswith("/"):
                relative_path += "index.html"

            file_path = (FRONTEND_DIR / relative_path).resolve()
            try:
                file_path.relative_to(FRONTEND_DIR.resolve())
            except ValueError:
                self._write_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden"})
                return

            if not file_path.exists() or not file_path.is_file():
                file_path = FRONTEND_DIR / "index.html"

            content_type = "text/plain; charset=utf-8"
            if file_path.suffix == ".html":
                content_type = "text/html; charset=utf-8"
            elif file_path.suffix == ".css":
                content_type = "text/css; charset=utf-8"
            elif file_path.suffix == ".js":
                content_type = "application/javascript; charset=utf-8"

            self.send_response(HTTPStatus.OK)
            self.send_header("content-type", content_type)
            self.end_headers()
            self.wfile.write(file_path.read_bytes())

        def _write_json(self, status_code: HTTPStatus, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status_code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return FrontendHandler


def start_frontend_server(config: HostConfig, config_path: Path, status: HostStatus) -> ThreadingHTTPServer:
    if not FRONTEND_DIR.exists():
        raise FileNotFoundError(f"Frontend directory does not exist: {FRONTEND_DIR}")

    server = ThreadingHTTPServer(
        (config.front_host, config.front_port),
        make_frontend_handler(config_path=config_path, status=status),
    )
    thread = threading.Thread(target=server.serve_forever, name="chimera-front", daemon=True)
    thread.start()
    return server


class HostService:
    def __init__(
        self,
        *,
        config_path: Path = CONFIG_PATH,
        enable_frontend: bool = True,
        logger: Callable[[str], None] | None = None,
        on_status: Callable[[dict[str, Any]], None] | None = None,
        on_manifest: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.config_path = config_path
        self.enable_frontend = enable_frontend
        self.logger = logger or (lambda message: None)
        self.on_status = on_status
        self.on_manifest = on_manifest
        self.thread: threading.Thread | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.main_task: asyncio.Task[None] | None = None
        self.frontend_server: ThreadingHTTPServer | None = None
        self._lock = threading.Lock()
        self._status_context: dict[str, Any] = {}
        self._status_snapshot: dict[str, Any] = {}
        self._manifest_snapshot: dict[str, Any] = {
            "series": [],
            "totalSeries": 0,
            "totalVolumes": 0,
            "totalPages": 0,
        }

    @property
    def local_control_url(self) -> str | None:
        status = self.status_snapshot()
        if not status.get("frontendEnabled"):
            return None
        return f"http://{status['frontendHost']}:{status['frontendPort']}"

    def status_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._status_snapshot)

    def manifest_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "series": list(self._manifest_snapshot["series"]),
                "totalSeries": self._manifest_snapshot["totalSeries"],
                "totalVolumes": self._manifest_snapshot["totalVolumes"],
                "totalPages": self._manifest_snapshot["totalPages"],
            }

    def start(self) -> None:
        if self.thread is not None and self.thread.is_alive():
            return

        self.thread = threading.Thread(target=self._thread_main, name="chimera-host-service", daemon=True)
        self.thread.start()

    def stop(self, timeout: float | None = 5.0) -> None:
        loop = self.loop
        task = self.main_task
        if loop is not None and task is not None:
            loop.call_soon_threadsafe(task.cancel)

        frontend_server = self.frontend_server
        if frontend_server is not None:
            frontend_server.shutdown()

        thread = self.thread
        if thread is not None:
            thread.join(timeout=timeout)

    def restart(self) -> None:
        self.stop()
        self.start()

    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self.loop = loop
        self.main_task = loop.create_task(self._async_main())

        try:
            loop.run_until_complete(self.main_task)
        except asyncio.CancelledError:
            pass
        finally:
            pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
            for task in pending:
                task.cancel()

            if pending:
                with contextlib.suppress(Exception):
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))

            loop.close()
            self.loop = None
            self.main_task = None

    async def _async_main(self) -> None:
        status: HostStatus | None = None

        try:
            config = load_config(self.config_path)
            self._status_context = {
                "configPath": str(self.config_path),
                "wsUrl": config.ws_url,
                "seriesPaths": [str(path) for path in config.series_paths],
                "hostId": config.host_id,
                "hostUsername": config.host_username,
            }
            status = HostStatus(
                frontend_enabled=self.enable_frontend,
                frontend_host=config.front_host,
                frontend_port=config.front_port,
                on_change=self._handle_status,
            )

            if self.enable_frontend:
                self.frontend_server = start_frontend_server(config, self.config_path, status)
                self.logger(f"Local control panel available at http://{config.front_host}:{config.front_port}")

            await host_forever(
                config=config,
                status=status,
                logger=self.logger,
                on_manifest=self._handle_manifest,
            )
        except asyncio.CancelledError:
            self.logger("Host stopped")
            raise
        except Exception as exc:
            self.logger(f"Host failed during startup: {exc}")
            if status is not None:
                status.mark_disconnected(str(exc))
        finally:
            if self.frontend_server is not None:
                self.frontend_server.shutdown()
                self.frontend_server.server_close()
                self.frontend_server = None

    def _handle_status(self, snapshot: dict[str, Any]) -> None:
        merged_snapshot = {
            **self._status_context,
            **snapshot,
        }
        with self._lock:
            self._status_snapshot = dict(merged_snapshot)

        if self.on_status is not None:
            self.on_status(dict(merged_snapshot))

    def _handle_manifest(self, snapshot: dict[str, Any]) -> None:
        with self._lock:
            self._manifest_snapshot = {
                "series": list(snapshot["series"]),
                "totalSeries": snapshot["totalSeries"],
                "totalVolumes": snapshot["totalVolumes"],
                "totalPages": snapshot["totalPages"],
            }

        if self.on_manifest is not None:
            self.on_manifest(self.manifest_snapshot())


async def host_forever(
    config: HostConfig,
    status: HostStatus,
    logger: Callable[[str], None],
    on_manifest: Callable[[dict[str, Any]], None] | None = None,
) -> None:
    reconnect_delay_seconds = config.initial_reconnect_delay_seconds
    while True:
        try:
            manifest_payload, page_lookup, page_metadata, manifest_summary = build_manifest_payload(config)
            if on_manifest is not None:
                on_manifest(manifest_summary.snapshot())

            page_cache = PageByteCache(
                max_bytes=config.cache_bytes,
                max_entries=config.cache_pages,
                max_cacheable_page_bytes=config.max_cacheable_page_bytes,
            )
            runtime = HostRuntime(config=config, page_cache=page_cache, logger=logger)

            logger(
                "Prepared manifest with "
                f"{manifest_summary.total_series} series, "
                f"{manifest_summary.total_volumes} volumes, "
                f"{manifest_summary.total_pages} pages"
            )
            logger(
                "Host settings: "
                f"cache_bytes={config.cache_bytes} "
                f"cache_pages={config.cache_pages} "
                f"max_cacheable_page_bytes={config.max_cacheable_page_bytes} "
                f"idle_after_seconds={config.idle_after_seconds} "
                f"monitor_memory={config.monitor_memory}"
            )

            async with connect(config.ws_url, max_size=None) as websocket:
                logger(f"Connected to backend at {config.ws_url}")
                status.mark_connected()
                await serve_connection(
                    websocket=websocket,
                    manifest_payload=manifest_payload,
                    page_lookup=page_lookup,
                    page_metadata=page_metadata,
                    runtime=runtime,
                    logger=logger,
                )
                reconnect_delay_seconds = config.initial_reconnect_delay_seconds
        except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
            status.mark_disconnected(f"Invalid host config or library paths: {exc}")
            logger(f"Invalid host config or library paths: {exc}")
        except ConnectionClosed as exc:
            error = f"Disconnected from backend: code={exc.code} reason={exc.reason or 'no reason provided'}"
            status.mark_disconnected(error)
            logger(error)
        except OSError as exc:
            error = f"Failed to connect to backend: {exc}"
            status.mark_disconnected(error)
            logger(error)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error = f"Hoster connection loop crashed: {exc}"
            status.mark_disconnected(error)
            logger(error)

        logger(f"Retrying connection in {reconnect_delay_seconds} seconds")
        await asyncio.sleep(reconnect_delay_seconds)
        reconnect_delay_seconds = min(reconnect_delay_seconds * 2, config.max_reconnect_delay_seconds)


async def serve_connection(
    websocket,
    manifest_payload: dict[str, Any],
    page_lookup: dict[str, Path],
    page_metadata: dict[str, dict[str, Any]],
    runtime: HostRuntime,
    logger: Callable[[str], None],
) -> None:
    request_tasks: dict[str, asyncio.Task[None]] = {}
    cancelled_request_ids: set[str] = set()
    memory_task: asyncio.Task[None] | None = None
    idle_task: asyncio.Task[None] | None = None

    greeting = await websocket.recv()
    logger("Server:")
    logger(str(greeting))

    await websocket.send(json.dumps(manifest_payload))

    register_response = await websocket.recv()
    logger("Register response:")
    logger(str(register_response))
    logger("Host connected. Open http://localhost:8000 in your browser.")

    if runtime.config.monitor_memory:
        memory_task = asyncio.create_task(report_memory_usage(runtime=runtime, request_tasks=request_tasks, logger=logger))
    if runtime.config.idle_after_seconds > 0:
        idle_task = asyncio.create_task(monitor_idle_mode(runtime))

    try:
        async for raw_message in websocket:
            if not isinstance(raw_message, str):
                logger("Ignoring unexpected binary message from backend")
                continue

            message = json.loads(raw_message)
            logger("Backend message:")
            logger(str(message))

            message_type = message.get("type")
            if message_type == "page_request":
                request_id = message.get("requestId")
                page_id = message.get("pageId")

                if request_id is None or page_id is None:
                    continue

                await runtime.record_request_activity()
                cancelled_request_ids.discard(request_id)
                if request_id in request_tasks:
                    logger(f"Skipping duplicate page request for requestId={request_id}")
                    continue

                task = asyncio.create_task(
                    serve_page_request(
                        websocket=websocket,
                        message=message,
                        page_lookup=page_lookup,
                        page_metadata=page_metadata,
                        cancelled_request_ids=cancelled_request_ids,
                        runtime=runtime,
                        logger=logger,
                    )
                )
                request_tasks[request_id] = task
                task.add_done_callback(
                    lambda completed_task, rid=request_id: finish_request_task(
                        completed_task,
                        rid,
                        request_tasks,
                        cancelled_request_ids,
                        logger,
                    )
                )
                continue

            if message_type == "cancel_page_request":
                request_id = message.get("requestId")
                if request_id is None:
                    continue

                cancelled_request_ids.add(request_id)
                logger(f"Marked requestId={request_id} as cancelled")
                continue
    finally:
        if memory_task is not None:
            memory_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await memory_task

        if idle_task is not None:
            idle_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await idle_task

        for request_id in list(request_tasks):
            cancelled_request_ids.add(request_id)

        if request_tasks:
            await asyncio.gather(*request_tasks.values(), return_exceptions=True)


async def serve_page_request(
    websocket,
    message: dict[str, Any],
    page_lookup: dict[str, Path],
    page_metadata: dict[str, dict[str, Any]],
    cancelled_request_ids: set[str],
    runtime: HostRuntime,
    logger: Callable[[str], None],
) -> None:
    page_id = message.get("pageId")
    request_id = message.get("requestId")
    page_path = page_lookup.get(page_id)

    if request_id is None or page_id is None:
        return

    if request_id in cancelled_request_ids:
        logger(f"Dropping cancelled request before disk read for requestId={request_id}")
        return

    if page_path is None or not page_path.exists():
        await websocket.send(json.dumps({
            "type": "page_error",
            "requestId": request_id,
            "pageId": page_id,
            "error": f"Unknown page id: {page_id}",
        }))
        return

    page_record = page_metadata.get(page_id)
    if page_record is None:
        await websocket.send(json.dumps({
            "type": "page_error",
            "requestId": request_id,
            "pageId": page_id,
            "error": f"Page metadata missing for: {page_id}",
        }))
        return

    page_bytes = await runtime.page_cache.get(page_id)
    if page_bytes is None:
        try:
            page_bytes = await asyncio.to_thread(page_path.read_bytes)
        except OSError as exc:
            await websocket.send(json.dumps({
                "type": "page_error",
                "requestId": request_id,
                "pageId": page_id,
                "error": f"Failed to read page bytes: {exc}",
            }))
            return

        await runtime.page_cache.put(page_id, page_bytes)

    if request_id in cancelled_request_ids:
        logger(f"Dropping cancelled request after loading page bytes for requestId={request_id}")
        return

    envelope = json.dumps({
        "type": "page_response",
        "requestId": request_id,
        "pageId": page_id,
        "contentType": page_record["contentType"],
    }).encode("utf-8") + b"\n\n" + page_bytes

    if request_id in cancelled_request_ids:
        logger(f"Dropping cancelled request before websocket send for requestId={request_id}")
        return

    await websocket.send(envelope)
    logger(f"Served page bytes for {page_id}")


def finish_request_task(
    completed_task: asyncio.Task[None],
    request_id: str,
    request_tasks: dict[str, asyncio.Task[None]],
    cancelled_request_ids: set[str],
    logger: Callable[[str], None],
) -> None:
    request_tasks.pop(request_id, None)
    cancelled_request_ids.discard(request_id)

    if completed_task.cancelled():
        return

    exc = completed_task.exception()
    if exc is not None:
        logger(f"Request task failed for requestId={request_id}: {exc}")


async def report_memory_usage(
    runtime: HostRuntime,
    request_tasks: dict[str, asyncio.Task[None]],
    logger: Callable[[str], None],
) -> None:
    import psutil

    process = psutil.Process()

    while True:
        cache_stats = await runtime.page_cache.snapshot()
        rss_mb = process.memory_info().rss / (1024 * 1024)
        logger(
            "[hoster metrics] "
            f"rss_mb={rss_mb:.2f} "
            f"inflight_requests={len(request_tasks)} "
            f"cache_entries={cache_stats['entries']} "
            f"cache_mb={cache_stats['total_bytes'] / (1024 * 1024):.2f} "
            f"cache_hits={cache_stats['hits']} "
            f"cache_misses={cache_stats['misses']} "
            f"cache_evictions={cache_stats['evictions']}"
        )
        await asyncio.sleep(runtime.config.memory_interval_seconds)


async def monitor_idle_mode(runtime: HostRuntime) -> None:
    while True:
        await asyncio.sleep(DEFAULT_IDLE_POLL_INTERVAL_SECONDS)
        await runtime.maybe_enter_idle_mode()
