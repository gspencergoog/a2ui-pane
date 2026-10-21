#!/usr/bin/env python3
"""Persistent A2UI Express worker for the a2ui-pane MCP server.

Reads one JSON request per line from stdin and writes one JSON response per
line to stdout. The Node MCP server keeps a single worker alive for its
lifetime so the import cost of the A2UI agent SDK is paid once.

Request shape:
    {"id": 1, "op": "init", "catalogPaths": ["...", "..."], "version": "v1.0"}
    {"id": 2, "op": "compile", "dsl": "...", "surfaceId": "main", "version": "v1.0"}
    {"id": 3, "op": "instructions"}
    {"id": 4, "op": "decompile", "messages": [...]}
    {"id": 5, "op": "ping"}
    {"id": 6, "op": "synthesize", "intent": "...", "payload": {...}, "surfaceId": "main"}

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
        self.render_tool: Any = None
        self.default_version = "v1.0"

    def init(self, catalog_paths: str | list[str], version: str | None) -> dict[str, Any]:
        """Loads one or more catalog schemas and initializes the Express compiler and prompt generator.

        Args:
            catalog_paths: Filesystem path or list of paths to catalog JSON files.
            version: Optional protocol version string (defaults to `self.default_version`).

        Returns:
            A dictionary containing `catalogId`, `catalogIds`, `version`, and `componentCount`.

        Raises:
            OSError: If a catalog path cannot be opened or read.
            ValueError: If no catalog paths are provided or a catalog JSON is invalid.
        """
        from a2ui.core import Catalog
        try:
            from a2ui.inference_formats.express import (
                ExpressCompiler,
                ExpressPromptGenerator,
            )
        except ImportError:
            from a2ui.inference_formats.experimental.express import (
                ExpressCompiler,
                ExpressPromptGenerator,
            )

        paths = [catalog_paths] if isinstance(catalog_paths, str) else list(catalog_paths)
        paths = [p for p in paths if isinstance(p, str) and p.strip()]
        if not paths:
            raise ValueError("At least one catalog path is required to initialize the Express worker.")

        self.default_version = version or self.default_version
        loaded_catalogs: list[Any] = []
        for path in paths:
            with open(path, "r", encoding="utf-8") as handle:
                schema = json.load(handle)
            loaded_catalogs.append(
                Catalog.from_json(schema, protocol_version=self.default_version)
            )

        self.catalogs = loaded_catalogs
        self.compiler = ExpressCompiler(self.catalogs, version=self.default_version)
        self.prompt_generator = ExpressPromptGenerator(
            self.catalogs, version=self.default_version
        )
        # Built lazily by `synthesize`, so an SDK without the decision
        # package only fails that op, not `init`.
        self.render_tool = None
        decision_available, decision_reason = probe_decision_support()
        return {
            "catalogId": self.catalogs[0].catalog_id,
            "catalogIds": [c.catalog_id for c in self.catalogs],
            "version": self.compiler.version,
            "componentCount": sum(len(c.components) for c in self.catalogs),
            "decisionAvailable": decision_available,
            "decisionUnavailableReason": decision_reason,
        }

    def compile(self, dsl: str, surface_id: str, version: str | None) -> list[dict]:
        """Compiles A2UI Express DSL text into a list of A2UI message dictionaries.

        Args:
            dsl: Raw A2UI Express source text (with or without `<a2ui>` sentinels).
            surface_id: Default surface identifier when `surface(...)` is omitted.
            version: Optional target protocol version override.

        Returns:
            List of serialized A2UI server-to-client message dictionaries.

        Raises:
            RuntimeError: If `init` has not been called on this worker state.
        """
        from a2ui.parser.messages import to_message_dicts

        self._require_init()
        messages = self.compiler.compile(
            strip_sentinels(dsl), surface_id=surface_id, version=version
        )
        return to_message_dicts(messages)

    def instructions(self) -> str:
        """Generates the A2UI Express authoring prompt for the loaded catalogs.

        Returns:
            Markdown authoring instructions produced by `ExpressPromptGenerator`.

        Raises:
            RuntimeError: If `init` has not been called on this worker state.
        """
        self._require_init()
        return self.prompt_generator.generate()

    def decompile(self, messages: list[dict]) -> str:
        """Decompiles A2UI message dictionaries back into A2UI Express source text.

        Args:
            messages: List of A2UI server-to-client message dictionaries.

        Returns:
            Decompiled A2UI Express DSL string.

        Raises:
            RuntimeError: If `init` has not been called on this worker state.
        """
        try:
            from a2ui.inference_formats.express import ExpressDecompiler
        except ImportError:
            from a2ui.inference_formats.experimental.express import ExpressDecompiler
        from a2ui.parser.messages import to_message_models

        self._require_init()
        decompiler = ExpressDecompiler(self.catalogs)
        return decompiler.decompile(to_message_models(messages))

    def synthesize(self, args: dict[str, Any]) -> dict[str, Any]:
        """Renders A2UI messages from an intent and payload with the decision model.

        Delegates to the SDK's `DecisionRenderTool`, which validates the
        arguments, decodes a stringified payload, and falls back to a
        deterministic card when the model abstains.

        Args:
            args: The tool-call arguments: `intent`, `payload` (object, array,
                or JSON string), and optional `surfaceId`, `template`, and
                `fallbackDsl`.

        Returns:
            Dictionary with `messages`, `stage`, `confidence`, `entropy`, `dsl`,
            `fallbackSource`, and `selectedTemplateId`.

        Raises:
            RuntimeError: If the agent SDK has no decision package or the
                backend cannot be created.
            TypeError, ValueError: If the arguments are invalid.
        """
        from a2ui.parser.messages import to_message_dicts

        self._require_init()
        tool = self._get_render_tool()
        out = tool.run_sync(args)
        return {
            "messages": to_message_dicts(out.messages),
            "stage": str(out.stage.value),
            "confidence": out.confidence,
            "entropy": out.entropy,
            "dsl": out.to_express(self.catalogs),
            "fallbackSource": out.fallback_source,
            "selectedTemplateId": out.selected_template_id,
        }

    def _get_render_tool(self) -> Any:
        """Returns the `DecisionRenderTool`, building it on first use."""
        if self.render_tool is None:
            try:
                from a2ui.inference_formats.decision import DecisionRenderTool

                self.render_tool = DecisionRenderTool.from_env(
                    self.catalogs, surface_id="main"
                )
            except Exception as err:
                raise RuntimeError(
                    f"Decision synthesis is not available: {err}"
                ) from err
        return self.render_tool

    def _require_init(self) -> None:
        if self.compiler is None:
            raise RuntimeError("Worker not initialized; send an 'init' request first.")


def probe_decision_support() -> tuple[bool, str | None]:
    """Reports whether the loaded agent SDK can render decision intents.

    Imports the decision package without building a backend, so the probe is
    cheap and has no side effects. The reason is a short message suitable for
    showing to the agent when the feature is unavailable.

    Returns:
        `(True, None)` when `a2ui.inference_formats.decision` imports, else
        `(False, reason)`.
    """
    try:
        import a2ui.inference_formats.decision  # noqa: F401
    except ImportError as err:
        return False, (
            "the installed A2UI agent SDK has no `a2ui.inference_formats.decision`"
            f" package ({err})"
        )
    except Exception as err:  # noqa: BLE001 - a broken optional package must not break init
        return False, f"importing `a2ui.inference_formats.decision` failed: {err}"
    return True, None


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
            catalog_arg = request.get("catalogPaths") or request.get("catalogPath")
            if not catalog_arg:
                raise ValueError("Missing 'catalogPaths' or 'catalogPath' in init request.")
            info = state.init(catalog_arg, request.get("version"))
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
        if op == "synthesize":
            args = {k: v for k, v in request.items() if k not in ("id", "op")}
            return {"id": request_id, "ok": True, **state.synthesize(args)}
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


def selftest(catalog_paths: str | list[str], version: str) -> int:
    """Initializes the worker and compiles a small fixture; exit code reports success."""
    state = WorkerState()
    info = state.init(catalog_paths, version)
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
    """Parses CLI arguments and runs either `--selftest` or the stdio JSON-lines loop.

    Args:
        argv: Optional list of CLI arguments (defaults to `sys.argv[1:]`).

    Returns:
        Process exit code (`0` on success, non-zero on failure).
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true", help="Compile a fixture and exit.")
    parser.add_argument(
        "--catalog",
        action="append",
        help="Catalog JSON path (may be passed multiple times; selftest only).",
    )
    parser.add_argument("--version", default="v1.0", help="Protocol version (selftest only).")
    args = parser.parse_args(argv)

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    if args.selftest:
        if not args.catalog:
            parser.error("--selftest requires --catalog")
        return selftest(args.catalog, args.version)
    return serve(WorkerState())


if __name__ == "__main__":
    sys.exit(main())
