import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
IGNORED_DIRECTORY_NAMES = {"_cbz_backups", "__pycache__"}
VOLUME_NUMBER_PATTERN = re.compile(r"(\d+)")


@dataclass(frozen=True)
class Page:
    id: str
    volume_id: str
    index: int
    file_path: Path
    file_name: str
    content_type: str
    file_size: int


@dataclass(frozen=True)
class Volume:
    id: str
    series_id: str
    title: str
    volume_number: int | None
    pages: list[Page]


@dataclass(frozen=True)
class Series:
    id: str
    title: str
    volumes: list[Volume]


def scan_library(series_paths: list[Path]) -> list[Series]:
    return [scan_series(path) for path in series_paths]


def scan_series(root_path: Path) -> Series:
    if not root_path.exists():
        raise FileNotFoundError(f"Series path does not exist: {root_path}")
    if not root_path.is_dir():
        raise NotADirectoryError(f"Series path is not a directory: {root_path}")

    series_id = slugify(root_path.name)
    volumes: list[Volume] = []

    for volume_dir in sorted(root_path.iterdir(), key=lambda path: path.name):
        if not volume_dir.is_dir() or volume_dir.name in IGNORED_DIRECTORY_NAMES:
            continue

        pages = scan_volume_pages(series_id, volume_dir)
        if not pages:
            continue

        volume_number = parse_volume_number(volume_dir.name)
        volumes.append(Volume(
            id=build_volume_id(series_id, volume_number, volume_dir.name),
            series_id=series_id,
            title=volume_dir.name,
            volume_number=volume_number,
            pages=pages,
        ))

    return Series(id=series_id, title=root_path.name, volumes=volumes)


def scan_volume_pages(series_id: str, volume_dir: Path) -> list[Page]:
    volume_number = parse_volume_number(volume_dir.name)
    volume_id = build_volume_id(series_id, volume_number, volume_dir.name)
    pages: list[Page] = []

    image_files = [
        path for path in sorted(volume_dir.rglob("*"), key=lambda path: str(path.relative_to(volume_dir)))
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    ]

    for index, image_path in enumerate(image_files, start=1):
        content_type, _ = mimetypes.guess_type(str(image_path))
        pages.append(Page(
            id=f"{volume_id}-p{index:03d}",
            volume_id=volume_id,
            index=index,
            file_path=image_path,
            file_name=image_path.name,
            content_type=content_type or "application/octet-stream",
            file_size=image_path.stat().st_size,
        ))

    return pages


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")


def parse_volume_number(directory_name: str) -> int | None:
    match = VOLUME_NUMBER_PATTERN.search(directory_name)
    return int(match.group(1)) if match else None


def build_volume_id(series_id: str, volume_number: int | None, directory_name: str) -> str:
    if volume_number is not None:
        return f"{series_id}-v{volume_number:02d}"
    return f"{series_id}-{slugify(directory_name)}"
