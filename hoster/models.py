from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Page:
    id: str
    volume_id: str
    index: int
    file_path: Path
    file_name: str
    content_type: str
    file_size: int


@dataclass
class Volume:
    id: str
    series_id: str
    title: str
    volume_number: int | None
    directory: Path
    pages: list[Page]


@dataclass
class Series:
    id: str
    title: str
    root_path: Path
    volumes: list[Volume]


def to_json_dict(value: Series | Volume | Page) -> dict:
    data = asdict(value)
    return _convert_paths(data)


def _convert_paths(value):
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, list):
        return [_convert_paths(item) for item in value]
    if isinstance(value, dict):
        return {key: _convert_paths(item) for key, item in value.items()}
    return value
