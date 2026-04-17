from pathlib import Path
import asyncio
import json

from websockets.asyncio.client import connect

from scanner import scan_series

WS_URL = "ws://100.114.14.97:8000/ws/host"
SERIES_PATHS = [
    Path("D:/MANGA/Usogui"),
]
HOST_ID = "windows-koushik-host"
HOST_USERNAME = "WINDOWS-KOUSHIK"


def build_manifest_payload() -> tuple[dict, dict[str, Path], dict[str, dict]]:
    manifest_series_entries: list[dict] = []
    page_lookup: dict[str, Path] = {}
    page_metadata: dict[str, dict] = {}

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


async def host_forever() -> None:
    manifest_payload, page_lookup, page_metadata = build_manifest_payload()
    total_series = len(manifest_payload["series"])
    total_volumes = sum(len(series["volumes"]) for series in manifest_payload["series"])
    total_pages = len(page_lookup)

    print(f"Prepared manifest with {total_series} series, {total_volumes} volumes, {total_pages} pages")

    async with connect(WS_URL, max_size=None) as websocket:
        greeting = await websocket.recv()
        print("Server:")
        print(greeting)

        await websocket.send(json.dumps(manifest_payload))

        register_response = await websocket.recv()
        print("Register response:")
        print(register_response)
        print("Host connected. Open http://localhost:8000 in your browser.")

        async for raw_message in websocket:
            if not isinstance(raw_message, str):
                print("Ignoring unexpected binary message from backend")
                continue

            message = json.loads(raw_message)
            print("Backend message:")
            print(message)

            if message.get("type") != "page_request":
                continue

            page_id = message.get("pageId")
            request_id = message.get("requestId")
            page_path = page_lookup.get(page_id)

            if request_id is None or page_id is None:
                continue

            if page_path is None or not page_path.exists():
                await websocket.send(json.dumps({
                    "type": "page_error",
                    "requestId": request_id,
                    "pageId": page_id,
                    "error": f"Unknown page id: {page_id}",
                }))
                continue

            page_record = page_metadata.get(page_id)

            if page_record is None:
                await websocket.send(json.dumps({
                    "type": "page_error",
                    "requestId": request_id,
                    "pageId": page_id,
                    "error": f"Page metadata missing for: {page_id}",
                }))
                continue

            page_bytes = page_path.read_bytes()

            await websocket.send(json.dumps({
                "type": "page_response",
                "requestId": request_id,
                "pageId": page_id,
                "contentType": page_record["contentType"],
            }))
            await websocket.send(page_bytes)
            print(f"Served page bytes for {page_id}")


def main() -> None:
    asyncio.run(host_forever())


if __name__ == "__main__":
    main()
