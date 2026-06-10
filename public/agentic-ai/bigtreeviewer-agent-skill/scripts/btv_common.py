#!/usr/bin/env python3
"""Shared helpers for Big Tree Viewer agent scripts."""

from __future__ import annotations

import argparse
import base64
import html
import json
import pathlib
import tempfile
from typing import Any


DEFAULT_BTV_URL = "https://bigtreeviewer.net/"


def read_text(path: str) -> str:
    return pathlib.Path(path).read_text(encoding="utf-8")


def base64url_text(value: str) -> str:
    encoded = base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii")
    return encoded.rstrip("=")


def parse_bool(value: str | bool | None) -> bool | None:
    if value is None or isinstance(value, bool):
        return value
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"Expected true or false, got {value!r}.")


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("tree", nargs="?", help="Local Newick or NEXUS tree file.")
    parser.add_argument("--btv-url", default=DEFAULT_BTV_URL, help="Big Tree Viewer URL. Default: https://bigtreeviewer.net/")
    parser.add_argument("--payload-json", help="JSON file containing a Big Tree Viewer launch payload.")
    parser.add_argument("--metadata", help="Optional local CSV/TSV metadata file.")
    parser.add_argument("--metadata-key", help="Metadata column matched to tree labels.")
    parser.add_argument("--metadata-value", help="Metadata value/color column.")
    parser.add_argument("--view", choices=["rectangular", "circular", "spiral"], help="Tree view mode.")
    parser.add_argument("--order", choices=["asc", "desc", "input"], help="Child ordering.")
    parser.add_argument("--tip-labels", type=parse_bool, help="Show tip labels: true or false.")
    parser.add_argument("--genus-labels", type=parse_bool, help="Show genus labels: true or false.")
    parser.add_argument("--taxonomy", type=parse_bool, help="Show taxonomy overlays when the payload contains taxonomy.")
    parser.add_argument("--taxonomy-branch-colors", type=parse_bool, help="Color branches using taxonomy mapping.")
    parser.add_argument("--time-stripes", type=parse_bool, help="Show time stripes: true or false.")
    parser.add_argument("--scale-bars", type=parse_bool, help="Show scale bars: true or false.")
    parser.add_argument("--branch-thickness", type=float, help="Branch thickness scale.")
    parser.add_argument("--rotation", type=float, help="Circular rotation in degrees.")
    parser.add_argument("--spiral-turns", type=float, help="Number of spiral turns.")


def load_payload(args: argparse.Namespace) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    if args.payload_json:
        payload = json.loads(read_text(args.payload_json))
        if not isinstance(payload, dict):
            raise SystemExit("--payload-json must contain a JSON object.")
    if args.tree:
        payload["newick"] = read_text(args.tree)
        payload.setdefault("label", pathlib.Path(args.tree).stem)
    if args.metadata:
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "text": read_text(args.metadata),
            "label": pathlib.Path(args.metadata).name,
            "keyColumn": args.metadata_key,
            "valueColumn": args.metadata_value,
            "enabled": True,
        }
    visual = dict(payload.get("visual") or {})
    option_map = {
        "view": "viewMode",
        "order": "order",
        "tip_labels": "showTipLabels",
        "genus_labels": "showGenusLabels",
        "taxonomy": "taxonomyEnabled",
        "taxonomy_branch_colors": "taxonomyBranchColoringEnabled",
        "time_stripes": "showTimeStripes",
        "scale_bars": "showScaleBars",
        "branch_thickness": "branchThicknessScale",
        "rotation": "circularRotationDegrees",
        "spiral_turns": "spiralTurns",
    }
    for arg_name, payload_name in option_map.items():
        value = getattr(args, arg_name, None)
        if value is not None:
            visual[payload_name] = value
    if visual:
        payload["visual"] = visual
    if "newick" not in payload and "newickUrl" not in payload:
        raise SystemExit("Provide a local tree file or --payload-json with newick/newickUrl.")
    return payload


def normalize_btv_url(value: str) -> str:
    return value if value.endswith("/") else f"{value}/"


def write_launcher_html(payload: dict[str, Any], btv_url: str) -> pathlib.Path:
    payload_json = json.dumps(payload)
    target = normalize_btv_url(btv_url)
    html_text = f"""<!doctype html>
<meta charset="utf-8">
<title>Big Tree Viewer launcher</title>
<p>Opening Big Tree Viewer...</p>
<script>
const payload = {payload_json};
const viewer = window.open({json.dumps(target + "?btv_api=1")}, "_blank", "noopener=false");
window.addEventListener("message", (event) => {{
  if (event.data && event.data.type === "big-tree-viewer:ready") {{
    viewer.postMessage({{ type: "big-tree-viewer:load", payload }}, {json.dumps(target.rstrip("/"))});
  }}
  if (event.data && event.data.type === "big-tree-viewer:loaded") {{
    document.body.innerHTML = {json.dumps("<p>Loaded in Big Tree Viewer.</p>")};
  }}
  if (event.data && event.data.type === "big-tree-viewer:error") {{
    document.body.innerHTML = "<pre>" + {json.dumps(html.escape("Big Tree Viewer error: "))} + event.data.message + "</pre>";
  }}
}});
</script>
"""
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".html", delete=False)
    with handle:
        handle.write(html_text)
    return pathlib.Path(handle.name)
