from pathlib import Path
import json

from models import to_json_dict
from scanner import scan_series

SERIES_PATH = Path("/home/koushikk/MANGA/Usogui")


def main() -> None:
    series = scan_series(SERIES_PATH)
    print(json.dumps(to_json_dict(series), indent=2))


if __name__ == "__main__":
    main()
