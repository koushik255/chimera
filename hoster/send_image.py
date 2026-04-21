import asyncio
import contextlib
import json
from argparse import ArgumentParser, Namespace
from pathlib import Path
from typing import Any

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from scanner import scan_series

WS_URL = "ws://100.114.14.97:8000/ws/host"
SERIES_PATHS = [
    Path("D:/MANGA/Usogui"),
    Path("D:/MANGA/MAGI"),
]
HOST_ID = "windows-koushik-host"
HOST_USERNAME = "WINDOWS-KOUSHIK"
INITIAL_RECONNECT_DELAY_SECONDS = 1
MAX_RECONNECT_DELAY_SECONDS = 300
DEFAULT_MEMORY_INTERVAL_SECONDS = 60.0


def build_manifest_payload() -> tuple[dict[str, Any], dict[str, Path], dict[str, dict[str, Any]]]:
    manifest_series_entries: list[dict[str, Any]] = []
    page_lookup: dict[str, Path] = {}
    page_metadata: dict[str, dict[str, Any]] = {}

    for series_path in SERIES_PATHS:
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
            "id": HOST_ID,
            "username": HOST_USERNAME,
        },
        "series": manifest_series_entries,
    }

    return payload, page_lookup, page_metadata


async def host_forever(monitor_memory: bool, memory_interval_seconds: float) -> None:
    manifest_payload, page_lookup, page_metadata = build_manifest_payload()
    total_series = len(manifest_payload["series"])
    total_volumes = sum(len(series["volumes"]) for series in manifest_payload["series"])
    total_pages = len(page_lookup)

    print(f"Prepared manifest with {total_series} series, {total_volumes} volumes, {total_pages} pages")

    reconnect_delay_seconds = INITIAL_RECONNECT_DELAY_SECONDS
    while True:
        try:
            async with connect(WS_URL, max_size=None) as websocket:
                print(f"Connected to backend at {WS_URL}")
                await serve_connection(
                    websocket=websocket,
                    manifest_payload=manifest_payload,
                    page_lookup=page_lookup,
                    page_metadata=page_metadata,
                    monitor_memory=monitor_memory,
                    memory_interval_seconds=memory_interval_seconds,
                )
        except ConnectionClosed as exc:
            print(f"Disconnected from backend: code={exc.code} reason={exc.reason or 'no reason provided'}")
        except OSError as exc:
            print(f"Failed to connect to backend: {exc}")
        except Exception as exc:
            print(f"Hoster connection loop crashed: {exc}")

        print(f"Retrying connection in {reconnect_delay_seconds} seconds")
        await asyncio.sleep(reconnect_delay_seconds)
        reconnect_delay_seconds = min(reconnect_delay_seconds * 2, MAX_RECONNECT_DELAY_SECONDS)


async def serve_connection(
    websocket,
    manifest_payload: dict[str, Any],
    page_lookup: dict[str, Path],
    page_metadata: dict[str, dict[str, Any]],
    monitor_memory: bool,
    memory_interval_seconds: float,
) -> None:
    request_tasks: dict[str, asyncio.Task[None]] = {}
    cancelled_request_ids: set[str] = set()
    memory_task: asyncio.Task[None] | None = None

    greeting = await websocket.recv()
    print("Server:")
    print(greeting)

    await websocket.send(json.dumps(manifest_payload))

    register_response = await websocket.recv()
    print("Register response:")
    print(register_response)
    print("Host connected. Open http://localhost:8000 in your browser.")

    if monitor_memory:
        memory_task = asyncio.create_task(report_memory_usage(request_tasks, memory_interval_seconds))

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

    if request_id in cancelled_request_ids:
        print(f"Dropping cancelled request after disk read for requestId={request_id}")
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


async def report_memory_usage(
    request_tasks: dict[str, asyncio.Task[None]],
    memory_interval_seconds: float,
) -> None:
    import psutil

    process = psutil.Process()

    while True:
        rss_mb = process.memory_info().rss / (1024 * 1024)
        print(f"[hoster metrics] rss_mb={rss_mb:.2f} inflight_requests={len(request_tasks)}")
        await asyncio.sleep(memory_interval_seconds)


def parse_args() -> Namespace:
    parser = ArgumentParser(description="Run the chimera host process")
    parser.add_argument(
        "--monitor-memory",
        action="store_true",
        help="Periodically print memory usage and inflight request count",
    )
    parser.add_argument(
        "--memory-interval-seconds",
        type=float,
        default=DEFAULT_MEMORY_INTERVAL_SECONDS,
        help="Sampling interval for memory metrics when --monitor-memory is enabled",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    asyncio.run(
        host_forever(
            monitor_memory=args.monitor_memory,
            memory_interval_seconds=args.memory_interval_seconds,
        )
    )


if __name__ == "__main__":
    main()
