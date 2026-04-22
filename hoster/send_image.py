import argparse
import time

from host_service import HostService


def main() -> None:
    parser = argparse.ArgumentParser(description="Chimera Python host")
    parser.add_argument(
        "--front",
        action="store_true",
        help="Serve the local frontend using the frontHost/frontPort values from config.json",
    )
    args = parser.parse_args()

    service = HostService(enable_frontend=args.front, logger=print)
    service.start()

    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("Stopping host...")
    finally:
        service.stop()


if __name__ == "__main__":
    main()
