from pathlib import Path
import mimetypes
import re

from models import Page, Series, Volume

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
VOLUME_NUMBER_PATTERN = re.compile(r"(\d+)")
IGNORED_DIRECTORY_NAMES = {"_cbz_backups", "__pycache__"}


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def parse_volume_number(directory_name: str) -> int | None:
    match = VOLUME_NUMBER_PATTERN.search(directory_name)
    if not match:
        return None
    return int(match.group(1))


def scan_series(root_path: Path) -> Series:
    if not root_path.exists():
        raise FileNotFoundError(f"Series path does not exist: {root_path}")
    if not root_path.is_dir():
        raise NotADirectoryError(f"Series path is not a directory: {root_path}")

    series_id = slugify(root_path.name)
    volumes: list[Volume] = []

    volume_directories = [
        path for path in root_path.iterdir()
        if path.is_dir() and path.name not in IGNORED_DIRECTORY_NAMES
    ]

    for volume_dir in sorted(volume_directories, key=lambda p: p.name):
        pages = scan_volume_pages(series_id=series_id, volume_dir=volume_dir)
        if not pages:
            continue

        volume_number = parse_volume_number(volume_dir.name)
        volume_id = build_volume_id(series_id, volume_number, volume_dir.name)

        volumes.append(Volume(
            id=volume_id,
            series_id=series_id,
            title=volume_dir.name,
            volume_number=volume_number,
            directory=volume_dir,
            pages=pages,
        ))

    return Series(
        id=series_id,
        title=root_path.name,
        root_path=root_path,
        volumes=volumes,
    )


def scan_volume_pages(series_id: str, volume_dir: Path) -> list[Page]:
    volume_number = parse_volume_number(volume_dir.name)
    volume_id = build_volume_id(series_id, volume_number, volume_dir.name)
    pages: list[Page] = []

    image_files = [
        path for path in sorted(
            volume_dir.rglob("*"),
            key=lambda p: str(p.relative_to(volume_dir)),
        )
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    ]

    for index, image_path in enumerate(image_files, start=1):
        content_type, _ = mimetypes.guess_type(str(image_path))
        if content_type is None:
            content_type = "application/octet-stream"

        pages.append(Page(
            id=f"{volume_id}-p{index:03d}",
            volume_id=volume_id,
            index=index,
            file_path=image_path,
            file_name=image_path.name,
            content_type=content_type,
            file_size=image_path.stat().st_size,
        ))

    return pages


def build_volume_id(series_id: str, volume_number: int | None, directory_name: str) -> str:
    if volume_number is not None:
        return f"{series_id}-v{volume_number:02d}"
    return f"{series_id}-{slugify(directory_name)}"
