#!/usr/bin/env python3
"""Open a local tree or session in Big Tree Viewer."""

from __future__ import annotations

import argparse
import urllib.parse
import webbrowser

from btv_common import add_common_arguments, load_payload, normalize_btv_url, write_launcher_html


def main() -> None:
    parser = argparse.ArgumentParser(description="Open a tree or session in Big Tree Viewer.")
    add_common_arguments(parser)
    parser.add_argument("--session-url", help="Public URL for a .btvsession file.")
    parser.add_argument("--download-export", choices=["svg", "png"], help="Ask Big Tree Viewer to download an SVG or PNG from the opened browser.")
    parser.add_argument("--export-filename", help="Suggested filename for --download-export.")
    parser.add_argument("--width", type=int, default=2400, help="PNG download width when using --download-export png.")
    parser.add_argument("--height", type=int, default=2400, help="PNG download height when using --download-export png.")
    parser.add_argument("--print-url", action="store_true", help="Print the opened URL or launcher path.")
    args = parser.parse_args()

    if args.session_url and not args.tree and not args.payload_json:
        params = urllib.parse.urlencode({"btv_session_url": args.session_url})
        url = f"{normalize_btv_url(args.btv_url)}?{params}"
        if args.print_url:
            print(url)
        webbrowser.open(url)
        return

    payload = load_payload(args)
    if args.download_export:
        payload["export"] = {
            "format": args.download_export,
            "delivery": "download",
            "filename": args.export_filename,
            "width": args.width,
            "height": args.height,
        }
    launcher = write_launcher_html(payload, args.btv_url)
    url = launcher.as_uri()
    if args.print_url:
        print(url)
    webbrowser.open(url)


if __name__ == "__main__":
    main()
