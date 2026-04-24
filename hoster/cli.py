import argparse
import asyncio
import json

from host_service import build_manifest, load_config, resolve_config_path, run_host


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Chimera manga host")
    parser.add_argument("--config", default=None, help="Path to the config file.")
    parser.add_argument("--check", action="store_true", help="Validate config and scan the library, then exit.")
    parser.add_argument("--dump-manifest", action="store_true", help="Print the manifest JSON, then exit.")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    config_path = resolve_config_path(args.config)
    config = load_config(config_path)

    if args.check:
        _, _, summary = build_manifest(config)
        print(f"Config: {config_path}")
        print(f"Backend: {config.ws_url}")
        print(f"Host: {config.host_username} ({config.host_id})")
        print(f"Series paths: {len(config.series_paths)}")
        for series_path in config.series_paths:
            print(f"  - {series_path}")
        print(f"Library: {summary['series']} series, {summary['volumes']} volumes, {summary['pages']} pages")
        return

    if args.dump_manifest:
        manifest, _, _ = build_manifest(config)
        print(json.dumps(manifest, indent=2))
        return

    print(f"Using config: {config_path}")
    try:
        asyncio.run(run_host(config, print))
    except KeyboardInterrupt:
        print("Stopping host...")


if __name__ == "__main__":
    main()
