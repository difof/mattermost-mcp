#!/usr/bin/env python3
"""Reproduce the pinned Mattermost REST coverage inventory (audit-only PyYAML)."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

import yaml


VERSION = "11.11.1"
COMMIT = "3acb3a7f684d11ccfcec4e5bd11c79f64e3eabf9"
REPOSITORY = "https://github.com/mattermost/mattermost"
SOURCE_DIRS = ("api/v4/source", "server/channels/api4")
METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"}
REPO_ROOT = Path(__file__).resolve().parents[1]
GO_STRING = r'(?:"(?:[^"\\]|\\.)*"|`[^`]*`)'

# Explicitly reviewed tool-to-route mapping, not inferred from tool names. The
# canonical {user_id} route includes Mattermost's documented "me" alias.
TOOL_ROUTES = {
    "get_me": ["GET /api/v4/users/{user_id}"],
    "get_user": ["GET /api/v4/users/{user_id}", "GET /api/v4/users/username/{username}"],
    "search_users": ["POST /api/v4/users/search"],
    "get_user_status": ["GET /api/v4/users/{user_id}/status"],
    "set_status": ["PUT /api/v4/users/{user_id}/status"],
    "set_custom_status": ["PUT /api/v4/users/{user_id}/status/custom"],
    "post_message": ["POST /api/v4/posts"],
    "reply_thread": ["POST /api/v4/posts"],
    "get_channel_posts": ["GET /api/v4/channels/{channel_id}/posts"],
    "get_thread": ["GET /api/v4/posts/{post_id}/thread"],
    "get_post": ["GET /api/v4/posts/{post_id}"],
    "search_posts": ["POST /api/v4/teams/{team_id}/posts/search"],
    "edit_post": ["PUT /api/v4/posts/{post_id}/patch"],
    "delete_post": ["DELETE /api/v4/posts/{post_id}"],
    "send_dm": ["POST /api/v4/channels/direct", "POST /api/v4/channels/group", "POST /api/v4/posts"],
    "pin_post": ["POST /api/v4/posts/{post_id}/pin"],
    "unpin_post": ["POST /api/v4/posts/{post_id}/unpin"],
    "add_reaction": ["POST /api/v4/reactions"],
    "remove_reaction": ["DELETE /api/v4/users/{user_id}/posts/{post_id}/reactions/{emoji_name}"],
    "list_teams": ["GET /api/v4/users/{user_id}/teams"],
    "list_channels": ["GET /api/v4/users/{user_id}/teams/{team_id}/channels"],
    "get_channel": ["GET /api/v4/channels/{channel_id}"],
    "create_channel": ["POST /api/v4/channels"],
    "join_channel": ["POST /api/v4/channels/{channel_id}/members"],
    "leave_channel": ["DELETE /api/v4/channels/{channel_id}/members/{user_id}"],
    "archive_channel": ["DELETE /api/v4/channels/{channel_id}"],
    "list_channel_members": ["GET /api/v4/channels/{channel_id}/members"],
    "add_member": ["POST /api/v4/channels/{channel_id}/members"],
    "remove_member": ["DELETE /api/v4/channels/{channel_id}/members/{user_id}"],
    "get_unreads": [
        "GET /api/v4/users/{user_id}/teams/{team_id}/channels/members",
        "GET /api/v4/users/{user_id}/channels/{channel_id}/unread",
    ],
    "mark_channel_read": ["POST /api/v4/channels/members/{user_id}/view"],
    "upload_file": ["POST /api/v4/files"],
    "get_file": ["GET /api/v4/files/{file_id}"],
    "get_file_metadata": ["GET /api/v4/files/{file_id}/info"],
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def request(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "mattermost-mcp-api-coverage-audit"})
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.read()


def download_source(cache: Path) -> dict[str, bytes]:
    """The immutable commit's Git blob IDs authenticate even a reused cache."""
    entries = []
    for directory in SOURCE_DIRS:
        url = f"https://api.github.com/repos/mattermost/mattermost/contents/{directory}?ref={COMMIT}"
        for entry in json.loads(request(url)):
            name = entry["name"]
            if entry["type"] == "file" and (
                name.endswith(".yaml") or (name.endswith(".go") and not name.endswith("_test.go"))
            ):
                entries.append(entry)

    def fetch(entry: dict) -> tuple[str, bytes]:
        target = cache / entry["path"]
        data = target.read_bytes() if target.exists() else b""

        def correct_blob(content: bytes) -> bool:
            header = f"blob {len(content)}\0".encode()
            return hashlib.sha1(header + content).hexdigest() == entry["sha"]

        if not correct_blob(data):
            data = request(f"https://raw.githubusercontent.com/mattermost/mattermost/{COMMIT}/{entry['path']}")
            if not correct_blob(data):
                raise ValueError(f"Git blob mismatch: {entry['path']}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        return entry["path"], data

    with ThreadPoolExecutor(max_workers=8) as pool:
        return dict(pool.map(fetch, entries))


def checkout_source(source: Path) -> dict[str, bytes]:
    def git(*args: str) -> str:
        return subprocess.check_output(["git", "-C", str(source), *args], text=True).strip()

    if git("rev-parse", "HEAD") != COMMIT:
        raise ValueError(f"Source checkout must be exactly {COMMIT} (v{VERSION})")
    if git("status", "--porcelain", "--", *SOURCE_DIRS):
        raise ValueError("Source API directories have changes or untracked files")
    files = git("ls-files", "--", *SOURCE_DIRS).splitlines()
    return {
        name: (source / name).read_bytes()
        for name in files
        if name.endswith(".yaml") or (name.endswith(".go") and not name.endswith("_test.go"))
    }


def route_key(method: str, path: str) -> str:
    return method.upper() + " " + path.rstrip("/")


def shape(key: str) -> str:
    """Parameter spelling is not a distinct HTTP operation."""
    return re.sub(r"\{[^{}]+\}", "{}", key)


def go_string(literal: str) -> str:
    return literal[1:-1] if literal.startswith("`") else json.loads(literal)


def documented_routes(files: dict[str, bytes]) -> dict[str, dict]:
    routes = {}
    for filename, data in sorted(files.items()):
        if not filename.endswith(".yaml"):
            continue
        spec = yaml.safe_load(data)
        for path, item in spec.items():
            if not path.startswith("/"):
                continue
            for method, operation in item.items():
                if method.upper() not in METHODS:
                    continue
                key = route_key(method, path)
                if key in routes:
                    raise ValueError(f"Duplicate OpenAPI route: {key}")
                record = {
                    "operation_id": operation["operationId"],
                    "openapi": filename,
                    "tags": operation.get("tags", []),
                }
                description = operation.get("description", "")
                permission_section = re.search(r"#+\s*Permissions\s*\n(.*?)(?=\n#+\s|\Z)", description, re.S | re.I)
                if permission_section:
                    # These are references, not an evaluated AND/OR policy.
                    terms = re.findall(r"`([a-z][a-z0-9_]+)`", permission_section[1])
                    if terms:
                        record["documented_permission_terms"] = sorted(set(terms))
                minimum = re.search(r"Minimum server version[_*\s:]*([0-9]+(?:\.[0-9]+)*)", description, re.I)
                if minimum:
                    record["documented_minimum_version"] = minimum[1]
                if operation.get("deprecated"):
                    record["deprecated"] = True
                routes[key] = record
    return routes


def functions(text: str) -> list[tuple[str, str, int]]:
    """Slice top-level Go functions; pinned registrations are literal statements."""
    declarations = list(re.finditer(r"^func\s+(?:\([^\n]*?\)\s+)?(\w+)\s*\(", text, re.M))
    return [
        (match[1], text[match.start() : declarations[i + 1].start() if i + 1 < len(declarations) else len(text)], match.start())
        for i, match in enumerate(declarations)
    ]


def registered_routes(files: dict[str, bytes]) -> tuple[dict[str, dict], list[dict], dict[str, dict]]:
    api_file = "server/channels/api4/api.go"
    init = next(body for name, body, _ in functions(files[api_file].decode()) if name == "Init")
    prefixes = {"Root": "", "APIRoot": "/api/v4", "APIRoot5": "/api/v5"}
    assignment = re.compile(r'api\.BaseRoutes\.(\w+)\s*=\s*api\.BaseRoutes\.(\w+)\.PathPrefix\((' + GO_STRING + r')\)\.Subrouter\(\)')
    for match in assignment.finditer(init):
        prefixes[match[1]] = prefixes[match[2]] + go_string(match[3])

    registration = re.compile(
        r'api\.BaseRoutes\.(\w+)\.Handle\((' + GO_STRING + r'),\s*(.*?)\)\.Methods\(([^)]*)\)', re.S
    )
    routes = {}
    excluded = []
    local_routes = {}
    for filename, data in sorted(files.items()):
        if not filename.endswith(".go"):
            continue
        text = data.decode()
        bodies = {name: body for name, body, _ in functions(text)}
        for function, body, offset in functions(text):
            is_local = "Local" in function or filename.endswith("_local.go")
            if "api.BaseRoutes." not in body or ".Handle(" not in body:
                continue
            if not (function.startswith("Init") or function.startswith("init")):
                raise ValueError(f"Review unexpected registration function: {filename}:{function}")
            matches = list(registration.finditer(body))
            if len(matches) != len(re.findall(r"api\.BaseRoutes\.\w+\.Handle\(", body)):
                raise ValueError(f"Unparsed registration: {filename}:{function}")
            for match in matches:
                raw_path = prefixes[match[1]] + go_string(match[2])
                wrappers = re.findall(r"api\.(API\w+|CloudAPIKeyRequired|RemoteClusterTokenRequired)\((\w+(?:\.\w+)?)", match[3])
                if len(wrappers) != 1:
                    raise ValueError(f"Review authentication wrapper: {filename}:{match[0]}")
                wrapper, handler = wrappers[0]
                methods = [constant or literal for constant, literal in re.findall(r'http\.Method(\w+)|"([A-Z]+)"', match[4])]
                if not methods or any(method.upper() not in METHODS for method in methods):
                    raise ValueError(f"Unparsed methods: {filename}:{match[0]}")
                line = text.count("\n", 0, offset + match.start()) + 1
                paths = [raw_path]
                if "{syncable_type:teams|channels}" in raw_path:
                    paths = [raw_path.replace("{syncable_type:teams|channels}", kind) for kind in ("teams", "channels")]
                for raw_variant in paths:
                    path = re.sub(r"\{(\w+):[^{}]*\}", r"{\1}", raw_variant)
                    for method in methods:
                        key = route_key(method, path)
                        record = {
                            "server": f"{filename}:{line}",
                            "handler": handler,
                            "auth_wrapper": wrapper,
                        }
                        if is_local:
                            local_routes[key] = record
                            continue
                        if not path.startswith("/api/v4/") or handler == "connectWebSocket":
                            excluded.append({"route": key, **record, "reason": "websocket" if handler == "connectWebSocket" else "outside_v4"})
                            continue
                        handler_body = bodies.get(handler, "")
                        permissions = re.findall(r"model\.(Permission\w+)", handler_body)
                        if permissions:
                            record["server_permission_constants"] = sorted(set(permissions))
                        settings = re.findall(r"Config\(\)\.(\w+)\.(\w+)", handler_body)
                        if settings:
                            record["server_config_references"] = sorted({".".join(item) for item in settings})
                        if function in {"InitProperties", "initChannelJoinRequestRoutes"} or handler == "getManagedCategories":
                            record["registration_feature_flags"] = sorted(set(re.findall(r"FeatureFlags\.(\w+)", body)))
                        if key in routes:
                            raise ValueError(f"Duplicate server route: {key}")
                        routes[key] = record
    return routes, excluded, local_routes


def build_inventory(files: dict[str, bytes]) -> dict:
    docs = documented_routes(files)
    server, excluded, local = registered_routes(files)
    docs_v4 = {key: value for key, value in docs.items() if key.split(" ", 1)[1].startswith("/api/v4/")}
    docs_rest = {key: value for key, value in docs_v4.items() if key != "GET /api/v4/websocket"}
    doc_shapes = {shape(key): key for key in docs_rest}
    if len(doc_shapes) != len(docs_rest) or len({shape(key) for key in server}) != len(server):
        raise ValueError("Duplicate OpenAPI shapes need review")
    routes = {key: dict(value) for key, value in docs_rest.items()}
    for key, record in server.items():
        routes.setdefault(doc_shapes.get(shape(key), key), {}).update(record)
    local_shapes = {shape(key): value for key, value in local.items()}
    for key, record in routes.items():
        if "server" not in record and shape(key) in local_shapes:
            record["local_socket_only"] = local_shapes[shape(key)]

    tool_files = [f"src/tools/{domain}.ts" for domain in ("users", "messaging", "channels", "files")]
    names = []
    for filename in tool_files:
        names.extend(re.findall(r'\bname:\s*"([a-z_]+)"', (REPO_ROOT / filename).read_text()))
    if sorted(names) != sorted(TOOL_ROUTES):
        raise ValueError("MCP tools changed: review TOOL_ROUTES before updating the audit")
    for tool, keys in TOOL_ROUTES.items():
        for key in keys:
            if key not in routes or "server" not in routes[key] or "openapi" not in routes[key]:
                raise ValueError(f"Covered route is not documented and registered: {tool}: {key}")
            routes[key].setdefault("mcp_tools", []).append(tool)
    for record in routes.values():
        if "mcp_tools" in record:
            record["mcp_tools"].sort()

    counts = {
        "mcp_tools": len(TOOL_ROUTES),
        "covered_routes": sum("mcp_tools" in record for record in routes.values()),
        "documented_operations_all_paths": len(docs),
        "documented_v4_operations": len(docs_v4),
        "documented_v4_rest_operations": len(docs_rest),
        "registered_core_v4_rest_operations": len(server),
        "documented_and_registered": sum("openapi" in record and "server" in record for record in routes.values()),
        "documented_without_core_registration": sum("server" not in record for record in routes.values()),
        "registered_without_openapi": sum("openapi" not in record for record in routes.values()),
        "documented_local_socket_only": sum("local_socket_only" in record for record in routes.values()),
        "inventory_union": len(routes),
    }
    return {
        "schema_version": 1,
        "source": {
            "mattermost_version": VERSION,
            "tag": f"v{VERSION}",
            "commit": COMMIT,
            "repository": REPOSITORY,
            "openapi_url": f"{REPOSITORY}/tree/{COMMIT}/api/v4/source",
            "server_url": f"{REPOSITORY}/tree/{COMMIT}/server/channels/api4",
            "source_sha256": {name: digest(data) for name, data in sorted(files.items())},
        },
        "scope": {
            "unit": "Unique HTTP method + normalized path; /users/me uses /users/{user_id}.",
            "included": "Documented /api/v4 REST operations plus literal core api4 HTTP route registrations, including conditional registrations. Five documented local-only operations are retained and labeled for comparison, not counted as registered HTTP endpoints.",
            "excluded": "Local socket routes, /api/v5, plugin-defined APIs, WebSocket operations, root endpoints, and catch-all 404 handlers.",
            "permission_metadata": "Lexical references only, not an evaluated permission policy. Empty/missing lists do not mean unrestricted access. Handler helpers, app logic, account roles, membership, licenses and configuration remain authoritative.",
            "coverage": "At least one current MCP tool invokes this method/path. Not full input, response, permission, server-version or live integration coverage.",
        },
        "mcp_source_sha256": {name: digest((REPO_ROOT / name).read_bytes()) for name in tool_files},
        "counts": counts,
        "registered_auth_wrapper_counts": {
            wrapper: sum(record["auth_wrapper"] == wrapper for record in server.values())
            for wrapper in sorted({record["auth_wrapper"] for record in server.values()})
        },
        "tool_routes": dict(sorted(TOOL_ROUTES.items())),
        "routes": dict(sorted(routes.items())),
        "documented_excluded": {key: value for key, value in docs.items() if key not in docs_rest},
        "registered_excluded": sorted(excluded, key=lambda record: record["route"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--source", type=Path, help=f"Clean Mattermost checkout at {COMMIT}")
    mode.add_argument("--download", action="store_true", help="Read public source at the immutable commit")
    parser.add_argument("--cache", type=Path, default=Path("/tmp/mattermost-v11-api-audit"))
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "docs/api-coverage.json")
    parser.add_argument("--check", action="store_true", help="Compare with output without overwriting it")
    args = parser.parse_args()
    files = checkout_source(args.source) if args.source else download_source(args.cache)
    inventory = build_inventory(files)
    if args.check:
        if json.loads(args.output.read_text()) != inventory:
            raise ValueError(f"Inventory differs: {args.output}")
        print("Inventory matches pinned source and current tool mapping.")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(inventory, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(inventory["counts"], indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"audit failed: {error}", file=sys.stderr)
        sys.exit(1)
