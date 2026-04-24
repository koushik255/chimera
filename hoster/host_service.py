import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from scanner import scan_library

DEFAULT_CONFIG_PATH = Path(__file__).with_name("config.json")
DEFAULT_RECONNECT_DELAY_SECONDS = 5.0


@dataclass(frozen=True)
class HostConfig:
    ws_url: str
    series_paths: list[Path]
    host_id: str
    host_username: str
    reconnect_delay_seconds: float


def resolve_config_path(config_path: str | Path | None = None) -> Path:
    if config_path is None:
        return DEFAULT_CONFIG_PATH
    return Path(config_path).expanduser().resolve()


def load_config(config_path: str | Path | None = None) -> HostConfig:
    path = resolve_config_path(config_path)
    raw = json.loads(path.read_text(encoding="utf-8"))

    series_paths = [Path(value).expanduser() for value in raw.get("seriesPaths", [])]
    host = raw.get("host", {})
    ws_url = str(raw.get("wsUrl", "")).strip()
    host_id = str(host.get("id", "")).strip()
    host_username = str(host.get("username", "")).strip()
    reconnect_delay_seconds = float(raw.get("reconnectDelaySeconds", DEFAULT_RECONNECT_DELAY_SECONDS))

    if not ws_url:
        raise ValueError("wsUrl must not be empty")
    if not series_paths:
        raise ValueError("seriesPaths must contain at least one path")
    if not host_id:
        raise ValueError("host.id must not be empty")
    if not host_username:
        raise ValueError("host.username must not be empty")
    if reconnect_delay_seconds <= 0:
        raise ValueError("reconnectDelaySeconds must be greater than 0")

    return HostConfig(
        ws_url=ws_url,
        series_paths=series_paths,
        host_id=host_id,
        host_username=host_username,
        reconnect_delay_seconds=reconnect_delay_seconds,
    )


def build_manifest(config: HostConfig) -> tuple[dict[str, Any], dict[str, Path], dict[str, Any]]:
    library = scan_library(config.series_paths)
    page_lookup: dict[str, Path] = {}
    series_payload: list[dict[str, Any]] = []

    for series in library:
        series_entry = {
            "id": series.id,
            "title": series.title,
            "volumes": [],
        }

        for volume in series.volumes:
            volume_entry = {
                "id": volume.id,
                "seriesId": volume.series_id,
                "title": volume.title,
                "volumeNumber": volume.volume_number,
                "pageCount": len(volume.pages),
                "pages": [],
            }

            for page in volume.pages:
                if page.id in page_lookup:
                    raise ValueError(f"duplicate page id: {page.id}")

                page_lookup[page.id] = page.file_path
                volume_entry["pages"].append({
                    "id": page.id,
                    "volumeId": page.volume_id,
                    "index": page.index,
                    "fileName": page.file_name,
                    "contentType": page.content_type,
                    "fileSize": page.file_size,
                })

            series_entry["volumes"].append(volume_entry)

        series_payload.append(series_entry)

    total_volumes = sum(len(series["volumes"]) for series in series_payload)
    summary = {
        "series": len(series_payload),
        "volumes": total_volumes,
        "pages": len(page_lookup),
    }

    manifest = {
        "type": "register_manifest",
        "host": {
            "id": config.host_id,
            "username": config.host_username,
        },
        "series": series_payload,
    }
    return manifest, page_lookup, summary


async def run_host(config: HostConfig, logger: Callable[[str], None]) -> None:
    while True:
        try:
            manifest, page_lookup, summary = build_manifest(config)
            logger(
                f"Prepared library: {summary['series']} series, "
                f"{summary['volumes']} volumes, {summary['pages']} pages"
            )

            async with connect(config.ws_url, max_size=None) as websocket:
                greeting = await websocket.recv()
                logger(f"Backend: {greeting}")

                await websocket.send(json.dumps(manifest))
                response = await websocket.recv()
                logger(f"Backend: {response}")

                request_tasks: dict[str, asyncio.Task[None]] = {}

                try:
                    async for raw_message in websocket:
                        if not isinstance(raw_message, str):
                            continue

                        message = json.loads(raw_message)
                        message_type = message.get("type")
                        request_id = message.get("requestId")

                        if message_type == "page_request" and request_id:
                            task = asyncio.create_task(
                                serve_page_request(websocket, page_lookup, message)
                            )
                            request_tasks[request_id] = task
                            task.add_done_callback(lambda done, rid=request_id: request_tasks.pop(rid, None))
                            continue

                        if message_type == "cancel_page_request" and request_id:
                            task = request_tasks.pop(request_id, None)
                            if task is not None:
                                task.cancel()
                            continue
                finally:
                    if request_tasks:
                        for task in request_tasks.values():
                            task.cancel()
                        await asyncio.gather(*request_tasks.values(), return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except ConnectionClosed as exc:
            logger(f"Disconnected: code={exc.code} reason={exc.reason or 'no reason provided'}")
        except Exception as exc:
            logger(f"Host error: {exc}")

        logger(f"Retrying in {config.reconnect_delay_seconds:.0f}s")
        await asyncio.sleep(config.reconnect_delay_seconds)


async def serve_page_request(websocket, page_lookup: dict[str, Path], message: dict[str, Any]) -> None:
    request_id = message.get("requestId")
    page_id = message.get("pageId")

    if not request_id or not page_id:
        return

    page_path = page_lookup.get(page_id)
    if page_path is None or not page_path.exists():
        await websocket.send(json.dumps({
            "type": "page_error",
            "requestId": request_id,
            "pageId": page_id,
            "error": f"Unknown page id: {page_id}",
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

    header = json.dumps({
        "type": "page_response",
        "requestId": request_id,
        "pageId": page_id,
        "contentType": guess_content_type(page_path),
    }).encode("utf-8")
    await websocket.send(header + b"\n\n" + page_bytes)


def guess_content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    return "application/octet-stream"
