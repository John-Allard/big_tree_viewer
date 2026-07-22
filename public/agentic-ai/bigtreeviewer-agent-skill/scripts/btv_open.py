#!/usr/bin/env python3
"""Open a local tree or session in one interactive Big Tree Viewer tab."""

from __future__ import annotations

import argparse
import pathlib
import re
import urllib.parse
import webbrowser

from btv_common import (
    add_common_arguments,
    export_dimensions_for_view,
    load_payload,
    normalize_btv_url,
    payload_view_mode,
    write_launcher_html,
)
from btv_headless import HeadlessRenderError, default_profile_dir, render_payload_headlessly


def default_export_filename(payload: dict, export_format: str) -> str:
    label = str(payload.get("label") or "big-tree-viewer").strip()
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", label).strip("-._") or "big-tree-viewer"
    return f"{base}-{payload_view_mode(payload)}-view.{export_format}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Open a tree or session in Big Tree Viewer.")
    add_common_arguments(parser)
    parser.add_argument("--session-url", help="Public URL for a .btvsession file.")
    parser.add_argument("--download-export", choices=["svg", "png"], help="Render and save an SVG or PNG in an isolated headless browser.")
    parser.add_argument("--export-filename", help="Output path for --download-export.")
    parser.add_argument("--width", type=int, help="PNG download width when using --download-export png. Defaults to a browser-window-scale size.")
    parser.add_argument("--height", type=int, help="PNG download height when using --download-export png. Defaults to a browser-window-scale size.")
    parser.add_argument("--export-viewport-width", type=int, help="CSS-pixel viewport width to use while rendering a PNG export.")
    parser.add_argument("--export-viewport-height", type=int, help="CSS-pixel viewport height to use while rendering a PNG export.")
    parser.add_argument("--browser", help="Chrome/Chromium/Edge executable for isolated export. Auto-detected by default.")
    parser.add_argument("--profile-dir", type=pathlib.Path, default=default_profile_dir(), help="Dedicated BTV automation browser profile.")
    parser.add_argument("--timeout", type=float, default=180, help="Maximum isolated export time in seconds. Default: 180.")
    parser.add_argument("--print-url", action="store_true", help="Print the opened URL or launcher path.")
    args = parser.parse_args()

    if args.session_url and (args.tree or args.payload_json):
        raise SystemExit("Use --session-url by itself, or provide a local tree/session/payload without --session-url.")

    if args.session_url and not args.download_export:
        params = urllib.parse.urlencode({"btv_session_url": args.session_url})
        url = f"{normalize_btv_url(args.btv_url)}?{params}"
        if args.print_url:
            print(url)
        if not webbrowser.open(url, new=2):
            raise SystemExit(f"Unable to open the default browser. Open this URL manually: {url}")
        return

    payload = load_payload(args, require_source=not bool(args.session_url))
    if args.session_url:
        payload["sessionUrl"] = args.session_url
    if args.download_export:
        export_width, export_height, export_viewport_width, export_viewport_height = export_dimensions_for_view(
            args.download_export,
            payload_view_mode(payload),
            args.width,
            args.height,
            args.export_viewport_width,
            args.export_viewport_height,
        )
        output = pathlib.Path(args.export_filename or default_export_filename(payload, args.download_export))
        payload["export"] = {
            "format": args.download_export,
            "delivery": "postMessage",
            "filename": output.name,
            "width": export_width,
            "height": export_height,
            "viewportWidth": export_viewport_width,
            "viewportHeight": export_viewport_height,
        }
        try:
            result = render_payload_headlessly(
                payload,
                btv_url=args.btv_url,
                output_path=output,
                export_format=args.download_export,
                browser_path=args.browser,
                profile_dir=args.profile_dir,
                timeout_seconds=args.timeout,
            )
        except HeadlessRenderError as error:
            raise SystemExit(f"Big Tree Viewer render failed: {error}") from error
        dimensions = f", {result.width} x {result.height}" if result.width and result.height else ""
        print(f"Rendered {args.download_export.upper()} to {result.output_path} ({result.byte_count:,} bytes{dimensions}).")
        return
    launcher = write_launcher_html(payload, args.btv_url)
    url = launcher.as_uri()
    if args.print_url:
        print(url)
    if not webbrowser.open(url, new=2):
        raise SystemExit(f"Unable to open the default browser. Open this URL manually: {url}")


if __name__ == "__main__":
    main()
