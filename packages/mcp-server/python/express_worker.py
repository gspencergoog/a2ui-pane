#!/usr/bin/env python3
"""Persistent A2UI Express worker for the a2ui-pane MCP server.

Reads one JSON request per line from stdin and writes one JSON response per
line to stdout. The Node MCP server keeps a single worker alive for its
lifetime so the import cost of the A2UI agent SDK is paid once.

Request shape:
    {"id": 1, "op": "init", "catalogPath": "...", "version": "v0.9"}
    {"id": 2, "op": "compile", "dsl": "...", "surfaceId": "main", "version": "v0.9"}
    {"id": 3, "op": "instructions"}
    {"id": 4, "op": "decompile", "messages": [...]}
    {"id": 5, "op": "ping"}

Response shape:
    {"id": 1, "ok": true, ...}
    {"id": 1, "ok": false, "error": {"kind": "...", "message": "...", "line": 3, "column": 7}}
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
from typing import Any

SENTINEL_OPEN = "<a2ui>"
SENTINEL_CLOSE = "</a2ui>"
_LINE_COL_RE = re.compile(r"line (\d+):(\d+)")


class WorkerState:
    """Holds the compiler and prompt generator built by the `init` request."""

    def __init__(self) -> None:
        self.catalogs: list[Any] = []
        self.compiler: Any = None
        self.prompt_generator: Any = None
        self.default_version = "v0.9"

    def init(self, catalog_path: str, version: str | None) -> dict[str, Any]:
        from a2ui.core import Catalog
        from a2ui.inference_formats.experimental.express import (
            ExpressCompiler,
            ExpressPromptGenerator,
        )

        self.default_version = version or self.default_version
        with open(catalog_path, "r", encoding="utf-8") as handle:
            schema = json.load(handle)
        catalog = Catalog.from_json(schema, protocol_version=self.default_version)
        self.catalogs = [catalog]
        self.compiler = ExpressCompiler(self.catalogs, version=self.default_version)
        self.prompt_generator = ExpressPromptGenerator(
            self.catalogs, version=self.default_version
        )
        return {
            "catalogId": catalog.catalog_id,
            "version": self.compiler.version,
            "componentCount": len(catalog.components),
        }

    def compile(self, dsl: str, surface_id: str, version: str | None) -> list[dict]:
        from a2ui.parser.messages import to_message_dicts

        self._require_init()
        messages = self.compiler.compile(
            strip_sentinels(dsl), surface_id=surface_id, version=version
        )
        return to_message_dicts(messages)

    def instructions(self) -> str:
        self._require_init()
        return self.prompt_generator.generate()

    def decompile(self, messages: list[dict]) -> str:
        from a2ui.inference_formats.experimental.express import ExpressDecompiler
        from a2ui.parser.messages import to_message_models

        self._require_init()
        decompiler = ExpressDecompiler(self.catalogs)
        return decompiler.decompile(to_message_models(messages))

    def _require_init(self) -> None:
        if self.compiler is None:
            raise RuntimeError("Worker not initialized; send an 'init' request first.")


def strip_sentinels(dsl: str) -> str:
    """Removes the `<a2ui>` sentinel tags if an agent included them."""
    text = dsl.strip()
    if text.startswith(SENTINEL_OPEN):
        text = text[len(SENTINEL_OPEN) :]
    if text.endswith(SENTINEL_CLOSE):
        text = text[: -len(SENTINEL_CLOSE)]
    return text.strip("\n")


def error_payload(exc: BaseException) -> dict[str, Any]:
    """Maps an exception to the wire error shape, extracting line/column and help when present."""
    message = str(exc)
    payload: dict[str, Any] = {"kind": type(exc).__name__, "message": message}
    # ExpressCompilerError keeps its corrective hint (valid properties, expected
    # argument shape) in help_message rather than in str(exc).
    help_message = getattr(exc, "help_message", None)
    if isinstance(help_message, str) and help_message and help_message not in message:
        payload["help"] = help_message
    line = getattr(exc, "line", None)
    column = getattr(exc, "column", None)
    if line is None:
        match = _LINE_COL_RE.search(message)
        if match:
            line = int(match.group(1))
            column = int(match.group(2))
    if line is not None:
        payload["line"] = line
    if column is not None:
        payload["column"] = column
    return payload


def handle(state: WorkerState, request: dict[str, Any]) -> dict[str, Any]:
    """Dispatches one request and returns the response object."""
    request_id = request.get("id")
    op = request.get("op")
    try:
        if op == "ping":
            return {"id": request_id, "ok": True, "initialized": state.compiler is not None}
        if op == "init":
            info = state.init(request["catalogPath"], request.get("version"))
            return {"id": request_id, "ok": True, **info}
        if op == "compile":
            messages = state.compile(
                request.get("dsl", ""),
                request.get("surfaceId") or "main",
                request.get("version"),
            )
            return {"id": request_id, "ok": True, "messages": messages}
        if op == "instructions":
            return {"id": request_id, "ok": True, "text": state.instructions()}
        if op == "decompile":
            return {"id": request_id, "ok": True, "text": state.decompile(request.get("messages", []))}
        return {
            "id": request_id,
            "ok": False,
            "error": {"kind": "UnknownOp", "message": f"Unknown op '{op}'"},
        }
    except Exception as exc:  # noqa: BLE001 - every failure must become a response line
        return {"id": request_id, "ok": False, "error": error_payload(exc)}


def serve(state: WorkerState) -> int:
    """Runs the JSON-lines loop until stdin closes."""
    out = sys.stdout
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            request = json.loads(raw)
        except json.JSONDecodeError as exc:
            response = {
                "id": None,
                "ok": False,
                "error": {"kind": "BadRequest", "message": f"Malformed JSON: {exc}"},
            }
        else:
            response = handle(state, request)
        out.write(json.dumps(response, ensure_ascii=False) + "\n")
        out.flush()
    return 0


def selftest(catalog_path: str, version: str) -> int:
    """Initializes the worker and compiles a small fixture; exit code reports success."""
    state = WorkerState()
    info = state.init(catalog_path, version)
    fixture = 'surface("selftest")\nroot = Card(Text("## genui selftest"))\n'
    messages = state.compile(fixture, "selftest", None)
    if not messages or "createSurface" not in messages[0]:
        print("express-worker: selftest produced unexpected output", file=sys.stderr)
        return 1
    print(
        f"express-worker: ok ({info['version']}, {info['componentCount']} components)",
        file=sys.stdout,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true", help="Compile a fixture and exit.")
    parser.add_argument("--catalog", help="Catalog JSON path (selftest only).")
    parser.add_argument("--version", default="v0.9", help="Protocol version (selftest only).")
    args = parser.parse_args(argv)

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    if args.selftest:
        if not args.catalog:
            parser.error("--selftest requires --catalog")
        return selftest(args.catalog, args.version)
    return serve(WorkerState())


if __name__ == "__main__":
    sys.exit(main())
