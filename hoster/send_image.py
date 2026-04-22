import asyncio
import contextlib
import json
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from typing import Any

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from scanner import scan_series

CONFIG_PATH = Path(__file__).with_name("config.json")
DEFAULT_MEMORY_INTERVAL_SECONDS = 60.0
DEFAULT_INITIAL_RECONNECT_DELAY_SECONDS = 1
DEFAULT_MAX_RECONNECT_DELAY_SECONDS = 300
DEFAULT_IDLE_POLL_INTERVAL_SECONDS = 15.0


@dataclass(frozen=True)
class HostConfig:
    ws_url: str
    series_paths: list[Path]
    host_id: str
    host_username: str
    monitor_memory: bool
    memory_interval_seconds: float
    cache_bytes: int
    max_cacheable_page_bytes: int
    idle_after_seconds: float
    initial_reconnect_delay_seconds: float
    max_reconnect_delay_seconds: float


class PageByteCache:
    def __init__(self, max_bytes: int, max_cacheable_page_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.max_cacheable_page_bytes = max_cacheable_page_bytes
        self.entries: OrderedDict[str, bytes] = OrderedDict()
        self.total_bytes = 0
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.lock = asyncio.Lock()

    async def get(self, page_id: str) -> bytes | None:
        if self.max_bytes <= 0:
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
        if self.max_bytes <= 0:
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

            while self.total_bytes > self.max_bytes and self.entries:
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
    def __init__(self, config: HostConfig, page_cache: PageByteCache) -> None:
        self.config = config
        self.page_cache = page_cache
        self.last_request_at = monotonic()
        self.idle = False
        self.activity_lock = asyncio.Lock()

    async def record_request_activity(self) -> None:
        async with self.activity_lock:
            was_idle = self.idle
            self.last_request_at = monotonic()
            self.idle = False

        if was_idle:
            print("[hoster idle] leaving idle mode because a new request arrived")

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
        print(
            "[hoster idle] entered idle mode after "
            f"{self.config.idle_after_seconds:.0f}s inactivity; cleared_cache_bytes={cleared_bytes}"
        )


def load_config(config_path: Path = CONFIG_PATH) -> HostConfig:
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    series_paths = [Path(value) for value in raw["seriesPaths"]]

    return HostConfig(
        ws_url=raw["wsUrl"],
        series_paths=series_paths,
        host_id=raw["host"]["id"],
        host_username=raw["host"]["username"],
        monitor_memory=raw.get("monitorMemory", False),
        memory_interval_seconds=float(raw.get("memoryIntervalSeconds", DEFAULT_MEMORY_INTERVAL_SECONDS)),
        cache_bytes=int(raw.get("cacheBytes", 0)),
        max_cacheable_page_bytes=int(raw.get("maxCacheablePageBytes", 0)),
        idle_after_seconds=float(raw.get("idleAfterSeconds", 0)),
        initial_reconnect_delay_seconds=float(
            raw.get("initialReconnectDelaySeconds", DEFAULT_INITIAL_RECONNECT_DELAY_SECONDS)
        ),
        max_reconnect_delay_seconds=float(
            raw.get("maxReconnectDelaySeconds", DEFAULT_MAX_RECONNECT_DELAY_SECONDS)
        ),
    )


def build_manifest_payload(
    config: HostConfig,
) -> tuple[dict[str, Any], dict[str, Path], dict[str, dict[str, Any]]]:
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

    return payload, page_lookup, page_metadata


async def host_forever(config: HostConfig) -> None:
    manifest_payload, page_lookup, page_metadata = build_manifest_payload(config)
    page_cache = PageByteCache(
        max_bytes=config.cache_bytes,
        max_cacheable_page_bytes=config.max_cacheable_page_bytes,
    )
    runtime = HostRuntime(config=config, page_cache=page_cache)
    total_series = len(manifest_payload["series"])
    total_volumes = sum(len(series["volumes"]) for series in manifest_payload["series"])
    total_pages = len(page_lookup)

    print(f"Prepared manifest with {total_series} series, {total_volumes} volumes, {total_pages} pages")
    print(
        "Host settings: "
        f"cache_bytes={config.cache_bytes} "
        f"max_cacheable_page_bytes={config.max_cacheable_page_bytes} "
        f"idle_after_seconds={config.idle_after_seconds} "
        f"monitor_memory={config.monitor_memory}"
    )

    reconnect_delay_seconds = config.initial_reconnect_delay_seconds
    while True:
        try:
            async with connect(config.ws_url, max_size=None) as websocket:
                print(f"Connected to backend at {config.ws_url}")
                await serve_connection(
                    websocket=websocket,
                    manifest_payload=manifest_payload,
                    page_lookup=page_lookup,
                    page_metadata=page_metadata,
                    runtime=runtime,
                )
                reconnect_delay_seconds = config.initial_reconnect_delay_seconds
        except ConnectionClosed as exc:
            print(f"Disconnected from backend: code={exc.code} reason={exc.reason or 'no reason provided'}")
        except OSError as exc:
            print(f"Failed to connect to backend: {exc}")
        except Exception as exc:
            print(f"Hoster connection loop crashed: {exc}")

        print(f"Retrying connection in {reconnect_delay_seconds} seconds")
        await asyncio.sleep(reconnect_delay_seconds)
        reconnect_delay_seconds = min(reconnect_delay_seconds * 2, config.max_reconnect_delay_seconds)


async def serve_connection(
    websocket,
    manifest_payload: dict[str, Any],
    page_lookup: dict[str, Path],
    page_metadata: dict[str, dict[str, Any]],
    runtime: HostRuntime,
) -> None:
    request_tasks: dict[str, asyncio.Task[None]] = {}
    cancelled_request_ids: set[str] = set()
    memory_task: asyncio.Task[None] | None = None
    idle_task: asyncio.Task[None] | None = None

    greeting = await websocket.recv()
    print("Server:")
    print(greeting)

    await websocket.send(json.dumps(manifest_payload))

    register_response = await websocket.recv()
    print("Register response:")
    print(register_response)
    print("Host connected. Open http://localhost:8000 in your browser.")

    if runtime.config.monitor_memory:
        memory_task = asyncio.create_task(
            report_memory_usage(runtime=runtime, request_tasks=request_tasks)
        )
    if runtime.config.idle_after_seconds > 0:
        idle_task = asyncio.create_task(monitor_idle_mode(runtime))

    try:
        async for raw_message in websocket:
            if not isinstance(raw_message, str):
                print("Ignoring unexpected binary message from backend")
                continue

            message = json.loads(raw_message)
            print("Backend message:")
            print(message)

            message_type = message.get("type")
            if message_type == "page_request":
                request_id = message.get("requestId")
                page_id = message.get("pageId")

                if request_id is None or page_id is None:
                    continue

                await runtime.record_request_activity()
                cancelled_request_ids.discard(request_id)
                if request_id in request_tasks:
                    print(f"Skipping duplicate page request for requestId={request_id}")
                    continue

                task = asyncio.create_task(
                    serve_page_request(
                        websocket=websocket,
                        message=message,
                        page_lookup=page_lookup,
                        page_metadata=page_metadata,
                        cancelled_request_ids=cancelled_request_ids,
                        runtime=runtime,
                    )
                )
                request_tasks[request_id] = task
                task.add_done_callback(
                    lambda completed_task, rid=request_id: finish_request_task(
                        completed_task,
                        rid,
                        request_tasks,
                        cancelled_request_ids,
                    )
                )
                continue

            if message_type == "cancel_page_request":
                request_id = message.get("requestId")
                if request_id is None:
                    continue

                cancelled_request_ids.add(request_id)
                print(f"Marked requestId={request_id} as cancelled")
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
) -> None:
    page_id = message.get("pageId")
    request_id = message.get("requestId")
    page_path = page_lookup.get(page_id)

    if request_id is None or page_id is None:
        return

    if request_id in cancelled_request_ids:
        print(f"Dropping cancelled request before disk read for requestId={request_id}")
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
        print(f"Dropping cancelled request after loading page bytes for requestId={request_id}")
        return

    envelope = json.dumps({
        "type": "page_response",
        "requestId": request_id,
        "pageId": page_id,
        "contentType": page_record["contentType"],
    }).encode("utf-8") + b"\n\n" + page_bytes

    if request_id in cancelled_request_ids:
        print(f"Dropping cancelled request before websocket send for requestId={request_id}")
        return

    await websocket.send(envelope)
    print(f"Served page bytes for {page_id}")


def finish_request_task(
    completed_task: asyncio.Task[None],
    request_id: str,
    request_tasks: dict[str, asyncio.Task[None]],
    cancelled_request_ids: set[str],
) -> None:
    request_tasks.pop(request_id, None)
    cancelled_request_ids.discard(request_id)

    if completed_task.cancelled():
        return

    exc = completed_task.exception()
    if exc is not None:
        print(f"Request task failed for requestId={request_id}: {exc}")


async def report_memory_usage(runtime: HostRuntime, request_tasks: dict[str, asyncio.Task[None]]) -> None:
    import psutil

    process = psutil.Process()

    while True:
        cache_stats = await runtime.page_cache.snapshot()
        rss_mb = process.memory_info().rss / (1024 * 1024)
        print(
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


def main() -> None:
    config = load_config()
    asyncio.run(host_forever(config))


if __name__ == "__main__":
    main()
