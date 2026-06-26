#!/usr/bin/env python3
"""Open a local tree or session in Big Tree Viewer."""

from __future__ import annotations

import argparse
import urllib.parse
import webbrowser

from btv_common import add_common_arguments, load_payload, normalize_btv_url, write_launcher_html

DEFAULT_RECTANGULAR_EXPORT_SIZE = (1600, 1000)
DEFAULT_SQUARE_EXPORT_SIZE = (1200, 1200)


def payload_view_mode(payload: dict) -> str:
    visual = payload.get("visual") if isinstance(payload.get("visual"), dict) else {}
    if isinstance(visual, dict) and visual.get("viewMode") in {"rectangular", "circular", "spiral"}:
        return str(visual["viewMode"])
    session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
    settings = session.get("settings") if isinstance(session.get("settings"), dict) else {}
    if isinstance(settings, dict) and settings.get("viewMode") in {"rectangular", "circular", "spiral"}:
        return str(settings["viewMode"])
    return "rectangular"


def export_dimensions_for_view(args: argparse.Namespace, view_mode: str) -> tuple[int | None, int | None, int | None, int | None]:
    if args.download_export != "png":
        return None, None, args.export_viewport_width, args.export_viewport_height
    if view_mode == "rectangular":
        return (
            args.width if args.width is not None else DEFAULT_RECTANGULAR_EXPORT_SIZE[0],
            args.height if args.height is not None else DEFAULT_RECTANGULAR_EXPORT_SIZE[1],
            args.export_viewport_width,
            args.export_viewport_height,
        )
    if args.width is not None and args.height is not None and args.width != args.height:
        raise SystemExit("Circular and spiral PNG exports must be square. Use equal --width and --height, or provide only one dimension.")
    if (
        args.export_viewport_width is not None
        and args.export_viewport_height is not None
        and args.export_viewport_width != args.export_viewport_height
    ):
        raise SystemExit("Circular and spiral PNG export viewports must be square. Use equal viewport dimensions, or provide only one.")
    size = args.width if args.width is not None else args.height
    if size is None:
        size = DEFAULT_SQUARE_EXPORT_SIZE[0]
    viewport_size = args.export_viewport_width if args.export_viewport_width is not None else args.export_viewport_height
    return size, size, viewport_size, viewport_size


def main() -> None:
    parser = argparse.ArgumentParser(description="Open a tree or session in Big Tree Viewer.")
    add_common_arguments(parser)
    parser.add_argument("--session-url", help="Public URL for a .btvsession file.")
    parser.add_argument("--download-export", choices=["svg", "png"], help="Ask Big Tree Viewer to download an SVG or PNG from the opened browser.")
    parser.add_argument("--export-filename", help="Suggested filename for --download-export.")
    parser.add_argument("--width", type=int, help="PNG download width when using --download-export png. Defaults to a browser-window-scale size.")
    parser.add_argument("--height", type=int, help="PNG download height when using --download-export png. Defaults to a browser-window-scale size.")
    parser.add_argument("--export-viewport-width", type=int, help="CSS-pixel viewport width to use while rendering a PNG export.")
    parser.add_argument("--export-viewport-height", type=int, help="CSS-pixel viewport height to use while rendering a PNG export.")
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
        export_width, export_height, export_viewport_width, export_viewport_height = export_dimensions_for_view(
            args,
            payload_view_mode(payload),
        )
        payload["export"] = {
            "format": args.download_export,
            "delivery": "download",
            "filename": args.export_filename,
            "width": export_width,
            "height": export_height,
            "viewportWidth": export_viewport_width,
            "viewportHeight": export_viewport_height,
        }
    launcher = write_launcher_html(payload, args.btv_url)
    url = launcher.as_uri()
    if args.print_url:
        print(url)
    webbrowser.open(url)


if __name__ == "__main__":
    main()
