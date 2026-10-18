#!/usr/bin/env python3
"""Generate the pinned REST catalog; Python + PyYAML are audit-only dependencies.

Use --download for immutable upstream source, --source for a clean checkout at
the pinned commit, or --cached-source for an authenticated offline cache. Run
audit-api-coverage.py first. --check verifies source, inventory and catalog;
it neither rewrites artifacts nor contacts a Mattermost deployment.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

import yaml

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("coverage_audit", Path(__file__).with_name("audit-api-coverage.py"))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)

# Only supplemental files used by the handwritten, source-backed corrections.
# SHA-256 values were verified from the same immutable revision as the audit.
EXTRA_SOURCES = {
    "server/public/model/channel_join_request.go": "fc88cb8900da9f7ffb890ea7f4cb271ece0640d04ced3c40ea49e73625a7890d",
    "server/channels/app/channel_join_request.go": "01a1be0f15f19a0daa7eec8c3a29ee04d87af778d6e68313936a09be96b7f7b4",
    "server/channels/web/params.go": "b761869701e7807037a03aa4219384e2cd0bae06dd8d4fdebd2483b31053dfbe",
    "server/public/model/group_syncable.go": "5930f6cd2e46b604c59f7bc1665311e5c411d3800900c897d34d4395559f72b4",
    "server/public/model/integration_action.go": "e5840e59ed2d7d6d96e60e008b8f417928d0a6e4eefd6d4bf11d170e096093cc",
    "server/public/model/push_notification.go": "797ff3e676f8bb666a0111e2fadc1d204ae22d35a8daeea8a0222035accc0e17",
    "server/public/model/cloud.go": "12313744c6729f14dd7fbd8da9ed553c8d4b7ae50102f07f452e858f6369ea1a",
}
AUTH = {
    "APIHandler": "public",
    "APIHandlerTrustRequester": "public",
    "APISessionRequired": "session",
    "APISessionRequiredTrustRequester": "session",
    "APISessionRequiredDisableWhenBusy": "session",
    "APISessionRequiredMfa": "session",
    "CloudAPIKeyRequired": "cloud",
    "RemoteClusterTokenRequired": "remote_cluster",
    "APILocal": "local",
}


def supplemental_source(directory: Path, download: bool, checkout: bool) -> dict[str, bytes]:
    if checkout:
        dirty = subprocess.check_output(
            ["git", "-C", str(directory), "status", "--porcelain", "--", *EXTRA_SOURCES], text=True
        ).strip()
        if dirty:
            raise ValueError("Supplemental source files have checkout changes")
    files = {}
    for name, expected in EXTRA_SOURCES.items():
        target = directory / name
        data = target.read_bytes() if target.exists() else b""
        if audit.digest(data) != expected and download:
            data = audit.request(f"https://raw.githubusercontent.com/mattermost/mattermost/{audit.COMMIT}/{name}")
            if audit.digest(data) == expected:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        if audit.digest(data) != expected:
            raise ValueError(f"Supplemental source hash mismatch or missing file: {name}")
        files[name] = data
    return files


def ref(name: str) -> dict:
    return {"$ref": f"#/components/schemas/{name}"}


def object_schema(properties: dict, required: tuple[str, ...] = ()) -> dict:
    schema = {"type": "object", "properties": properties}
    if required:
        schema["required"] = list(required)
    return schema


def json_body(schema: dict, required: bool = True, description: str | None = None) -> dict:
    body = {"required": required, "content": {"application/json": {"schema": schema}}}
    if description:
        body["description"] = description
    return body


def json_response(schema: dict, description: str) -> dict:
    return {"description": description, "content": {"application/json": {"schema": schema}}}


def parameter(name: str, schema: dict, description: str = "", required: bool = False) -> dict:
    value = {"name": name, "in": "query", "required": required, "schema": schema}
    if description:
        value["description"] = description
    return value


def build_catalog(files: dict[str, bytes], inventory: dict, extra: dict[str, bytes]) -> dict:
    specs = {name: yaml.safe_load(data) for name, data in files.items() if name.endswith(".yaml")}
    components = deepcopy(specs["api/v4/source/definitions.yaml"]["components"])
    components = {name: components[name] for name in ("schemas", "responses")}
    documents = {}
    for filename, spec in specs.items():
        for path, item in spec.items():
            if not path.startswith("/"):
                continue
            for method, operation in item.items():
                if method.upper() in audit.METHODS:
                    operation = deepcopy(operation)
                    operation["parameters"] = deepcopy(item.get("parameters", [])) + operation.get("parameters", [])
                    documents[audit.route_key(method, path)] = operation

    operations = {}
    corrections = []

    def correct(routes: list[str], reason: str, sources: list[str]) -> None:
        corrections.append({"operations": routes, "reason": reason, "sources": sources})

    for key, record in inventory["routes"].items():
        method, path = key.split(" ", 1)
        server = record.get("local_socket_only", record)
        wrapper = server["auth_wrapper"]
        auth = AUTH[wrapper]  # Unknown wrappers require explicit review.
        document = documents.get(key, {})
        operation = {"method": method, "path": path}
        for field in ("operationId", "summary", "description", "tags", "deprecated"):
            if field in document:
                operation[field] = document[field]
        operation.setdefault("summary", re.sub(r"(?<!^)([A-Z])", r" \1", server["handler"]).capitalize())
        operation.setdefault("tags", [path.split("/")[3]])
        operation.update({
            "auth": auth,
            "transport": "local" if auth == "local" else "http",
            "parameters": document.get("parameters", []),
            "responses": {str(status): response for status, response in document.get("responses", {}).items()},
            "source": {
                **({"openapi": record["openapi"]} if "openapi" in record else {}),
                "server": server["server"],
                "handler": server["handler"],
                "authWrapper": wrapper,
            },
        })
        if "requestBody" in document:
            operation["requestBody"] = document["requestBody"]
        for old, new in (
            ("server_permission_constants", "permissionReferences"),
            ("server_config_references", "configurationReferences"),
            ("registration_feature_flags", "featureFlags"),
        ):
            if old in record:
                operation["source"][new] = record[old]
        names = {p["name"] for p in operation["parameters"] if p["in"] == "path"}
        missing = [name for name in re.findall(r"\{([^{}]+)\}", path) if name not in names]
        for name in missing:
            operation["parameters"].append({"name": name, "in": "path", "required": True, "schema": {"type": "string"}})
        if missing and document:
            correct([key], f"Declare missing required path parameter(s): {', '.join(missing)}.", [server["server"]])
        operations[key] = operation

    # Explicit corrections address concrete disagreements with this revision's
    # server. Undocumented JSON fields remain allowed; this is not a validator
    # claiming that the OpenAPI or these targeted corrections are exhaustive.
    search_routes = ["POST /api/v4/files/search", "POST /api/v4/teams/{team_id}/files/search"]
    for key in search_routes:
        body = operations[key]["requestBody"]
        body["content"]["application/json"] = body["content"].pop("multipart/form-data")
        body["content"]["application/json"]["schema"]["required"] = ["terms"]
    correct(search_routes, "File search decodes JSON; only terms is required. is_or_search defaults to false.", ["server/channels/api4/file.go:961"])

    upload = operations["POST /api/v4/files"]
    upload["requestBody"]["content"]["application/octet-stream"] = {"schema": {"type": "string", "format": "binary"}}
    upload["requestBody"]["description"] = "Multipart upload with files and channel_id, or raw file bytes with required channel_id and filename query parameters. Raw uploads may also specify client_id. Use bookmark=true for bookmark attachments."
    upload["parameters"].extend([
        parameter("client_id", {"type": "string"}, "Optional client identifier for the raw upload mode."),
        parameter("bookmark", {"type": "boolean"}, "Upload a channel bookmark attachment."),
    ])
    correct(["POST /api/v4/files"], "Advertise the raw binary upload mode in addition to multipart and its optional query fields.", ["server/channels/api4/file.go:79", "server/channels/api4/file.go:134"])

    missing_bodies = {
        "POST /api/v4/cloud/webhook": json_body(object_schema({"event": {"type": "string"}}), description="Cloud service webhook payload; additional event-specific fields are accepted. Requires the cloud API key, not the account token."),
        "POST /api/v4/compliance/reports": json_body(ref("Compliance")),
        "POST /api/v4/elasticsearch/test": json_body(ref("Config"), required=False, description="Optional configuration; the handler falls back to the current configuration when absent or undecodable."),
        "POST /api/v4/notifications/ack": json_body(object_schema({
            "id": {"type": "string"}, "received_at": {"type": "integer", "format": "int64"},
            "platform": {"type": "string"}, "type": {"type": "string"},
            "post_id": {"type": "string"}, "is_id_loaded": {"type": "boolean"},
        })),
        "POST /api/v4/posts/{post_id}/actions/{action_id}": json_body(object_schema({
            "selected_option": {"type": "string"}, "cookie": {"type": "string"},
            "query": {"type": "object", "additionalProperties": {"type": "string"}},
            "integration_format": {"type": "string", "description": "attachment (default), apps_binding, block, card or mm_block; unrecognized values fall back to attachment."},
        }), required=False, description="Empty body is allowed for older interactive integrations."),
        "POST /api/v4/terms_of_service": json_body(object_schema({"text": {"type": "string"}}, ("text",))),
        "POST /api/v4/users/{user_id}/posts/{post_id}/set_unread": json_body(object_schema({"collapsed_threads_supported": {"type": "boolean"}}), required=False),
    }
    for kind in ("teams", "channels"):
        key = f"POST /api/v4/groups/{{group_id}}/{kind}/{{{kind[:-1]}_id}}/link"
        missing_bodies[key] = json_body(object_schema({
            "auto_add": {"type": "boolean", "nullable": True},
            "scheme_admin": {"type": "boolean", "nullable": True},
        }))
    for key, body in missing_bodies.items():
        if "requestBody" in operations[key]:
            raise ValueError(f"Previously missing request body now documented: review correction for {key}")
        operations[key]["requestBody"] = body
    correct(sorted(missing_bodies), "Describe JSON bodies parsed by handlers but absent from OpenAPI. These schemas intentionally allow additional fields.", sorted({operations[key]["source"]["server"] for key in missing_bodies}) + ["server/public/model/group_syncable.go", "server/public/model/integration_action.go", "server/public/model/push_notification.go", "server/public/model/cloud.go"])

    purge = operations["POST /api/v4/elasticsearch/purge_indexes"]
    purge["parameters"].append({**parameter("index", {"type": "array", "items": {"type": "string"}}, "Repeat index for each selected index; omission uses the handler's default index set."), "style": "form", "explode": True})
    correct(["POST /api/v4/elasticsearch/purge_indexes"], "Document the repeated index query parameter read by the handler.", [purge["source"]["server"]])

    activation = operations["GET /api/v4/access_control_policies/{policy_id}/activate"]
    active = next((p for p in activation["parameters"] if p["name"] == "active" and p["in"] == "query"), None)
    wanted_active = parameter("active", {"type": "boolean"}, "Required true or false. This deprecated GET mutates the policy and requires header-based authentication.", True)
    if active is None:
        activation["parameters"].append(wanted_active)
    else:
        active.update(wanted_active)
    correct(["GET /api/v4/access_control_policies/{policy_id}/activate"], "Activation consumes a required active query parameter, never a GET body; cookie authentication is rejected.", ["server/channels/api4/access_control.go:838"])

    custom = operations["GET /api/v4/users/{user_id}/custom_profile_attributes"]["responses"]["200"]["content"]
    custom["application/json"] = {"schema": custom.pop("schema")}
    correct(["GET /api/v4/users/{user_id}/custom_profile_attributes"], "Repair the response schema's misplaced indentation under content/application/json.", [operations["GET /api/v4/users/{user_id}/custom_profile_attributes"]["source"]["openapi"]])

    binary = {
        "/api/v4/files/{file_id}": "application/octet-stream",
        "/api/v4/files/{file_id}/thumbnail": "image/jpeg",
        "/api/v4/files/{file_id}/preview": "image/jpeg",
        "/api/v4/exports/{export_name}": "application/zip",
        "/api/v4/brand/image": "image/png",
        "/api/v4/users/{user_id}/image": "image/png",
        "/api/v4/users/{user_id}/image/default": "image/png",
        "/api/v4/teams/{team_id}/image": "image/png",
        "/api/v4/emoji/{emoji_id}/image": "image/*",
        "/api/v4/compliance/reports/{report_id}/download": "application/octet-stream",
    }
    for path, media in binary.items():
        operation = operations["GET " + path]
        operation["responses"]["200"] = {"description": "Raw file bytes; the actual Content-Type depends on the file.", "content": {media: {"schema": {"type": "string", "format": "binary"}}}}
        if "HEAD " + path in operations:
            operations["HEAD " + path]["responses"]["200"] = {"description": "File headers only; no response body."}
    correct(sorted("GET " + path for path in binary) + sorted("HEAD " + path for path in binary if "HEAD " + path in operations), "Declare binary success responses and bodyless HEAD success where OpenAPI omitted or mislabeled them. Response decoding uses the actual HTTP Content-Type.", sorted({operations["GET " + path]["source"]["server"] for path in binary}))

    add_join_requests(operations, components)
    join_routes = sorted(key for key, record in inventory["routes"].items() if "openapi" not in record)
    correct(join_routes, "Derive all seven discoverable-private-channel join-request contracts from the registered handlers, models and app validation because this revision's OpenAPI omits them.", ["server/channels/api4/channel_join_request.go", "server/public/model/channel_join_request.go", "server/channels/app/channel_join_request.go", "server/channels/web/params.go"])

    catalog = {
        "version": audit.VERSION,
        "source": {
            **inventory["source"],
            "supplemental_source_sha256": {name: audit.digest(data) for name, data in sorted(extra.items())},
            "scope": "601 inventoried core REST operations: 590 session/public HTTP, 6 special-auth HTTP, 5 documented local-socket operations. No plugin, WebSocket, /api/v5 or root routes.",
            "authentication": "auth is the route wrapper's credential family, not an evaluated permission grant. Public wrappers may require endpoint-specific credentials. Handler checks, account roles, membership, MFA, licenses, server settings and feature flags remain authoritative.",
            "schema_limitations": "OpenAPI plus explicit source-backed corrections; not an exhaustive schema for every server-accepted field or deployment response. Undocumented body/query fields may be needed. References are preserved for lazy transitive schema discovery.",
        },
        "operations": dict(sorted(operations.items())),
        "components": components,
        "corrections": corrections,
    }
    validate_catalog(catalog, inventory)
    return catalog


def add_join_requests(operations: dict, components: dict) -> None:
    statuses = ["pending", "approved", "denied", "withdrawn"]
    properties = {
        **{key: {"type": "string"} for key in ("id", "channel_id", "user_id", "reviewed_by")},
        "message": {"type": "string", "maxLength": 500},
        "status": {"type": "string", "enum": statuses},
        "denial_reason": {"type": "string", "maxLength": 500},
        **{key: {"type": "integer", "format": "int64", "description": "Unix milliseconds; reviewed_at is zero before review."} for key in ("create_at", "update_at", "reviewed_at")},
    }
    components["schemas"]["ChannelJoinRequest"] = object_schema(properties, tuple(properties))
    components["schemas"]["ChannelJoinRequestList"] = object_schema({
        "requests": {"type": "array", "items": ref("ChannelJoinRequest")},
        "total_count": {"type": "integer", "format": "int64"},
    }, ("requests", "total_count"))
    listing = [
        parameter("status", {"type": "string", "enum": statuses, "default": "pending"}, "Missing or unrecognized status defaults to pending."),
        parameter("page", {"type": "integer", "minimum": 0, "default": 0}, "Negative values are clamped to zero."),
        parameter("per_page", {"type": "integer", "minimum": 1, "maximum": 200, "default": 60}, "Nonpositive values use 60; values above 200 are clamped."),
    ]
    request = "/api/v4/channels/{channel_id}/join_request"
    queue = "/api/v4/channels/{channel_id}/join_requests"
    definitions = {
        "POST " + request: ("Request to join a discoverable private channel", "201", {"oneOf": [ref("ChannelJoinRequest"), object_schema({"status": {"type": "string", "enum": ["approved"]}}, ("status",))]}),
        "GET " + request: ("Get my pending request to join a channel", "200", ref("ChannelJoinRequest")),
        "DELETE " + request: ("Withdraw my pending channel join request", "200", ref("ChannelJoinRequest")),
        "GET " + queue: ("List a channel's join requests", "200", ref("ChannelJoinRequestList")),
        "GET " + queue + "/count": ("Count a channel's pending join requests", "200", object_schema({"count": {"type": "integer", "format": "int64"}}, ("count",))),
        "PATCH " + queue + "/{request_id}": ("Approve or deny a pending channel join request", "200", ref("ChannelJoinRequest")),
        "GET /api/v4/users/{user_id}/channel_join_requests": ("List my channel join requests", "200", ref("ChannelJoinRequestList")),
    }
    for key, (summary, status, schema) in definitions.items():
        operation = operations[key]
        operation["summary"] = summary
        operation["tags"] = ["channels", "join_requests"]
        operation["description"] = "Requires the DiscoverableChannels feature flag. Server membership, account and channel policy checks apply."
        operation["responses"] = {status: json_response(schema, "Successful channel join-request operation.")}
        operation["responses"].update({code: json_response(ref("AppError"), "Mattermost application error.") for code in ("400", "401", "403", "404", "409", "500")})
        if key in ("GET " + queue, "GET /api/v4/users/{user_id}/channel_join_requests"):
            operation["parameters"].extend(deepcopy(listing))
        if key.startswith("GET " + queue) or key.startswith("PATCH " + queue):
            operation["description"] += " Requires manage_channel_join_requests permission for this channel."
    operations["POST " + request]["requestBody"] = json_body(object_schema({"message": {"type": "string", "maxLength": 500}}), description="An empty JSON object is valid. The ABAC fast path may directly join the caller and return status approved.")
    operations["GET " + request]["responses"]["404"] = {"description": "Empty body when no pending request exists; other not-found errors may contain a Mattermost AppError.", "content": {"application/json": {"schema": ref("AppError")}}}
    operations["PATCH " + queue + "/{request_id}"]["requestBody"] = json_body(object_schema({
        "status": {"type": "string", "enum": ["approved", "denied"]},
        "denial_reason": {"type": "string", "nullable": True, "maxLength": 500, "description": "Used when denying; ignored when approving."},
    }, ("status",)))
    operations["GET /api/v4/users/{user_id}/channel_join_requests"]["description"] += " The user_id must identify the authenticated caller, including for administrators; use me for the current user."


def validate_catalog(catalog: dict, inventory: dict) -> None:
    if set(catalog["operations"]) != set(inventory["routes"]):
        raise ValueError("Catalog does not cover exactly the independently audited route universe")
    available = sum(op["transport"] == "http" and op["auth"] in {"session", "public"} for op in catalog["operations"].values())
    if available != inventory["counts"]["generic_callable_routes"]:
        raise ValueError("Catalog account-callable count differs from independently audited wrapper coverage")

    def walk(value):
        if isinstance(value, list):
            for child in value:
                walk(child)
        elif isinstance(value, dict):
            if "$ref" in value:
                reference = value["$ref"]
                if not reference.startswith("#/components/"):
                    raise ValueError(f"Nonlocal catalog reference needs review: {reference}")
                target = catalog
                for part in reference[2:].split("/"):
                    target = target[part.replace("~1", "/").replace("~0", "~")]
            for child in value.values():
                walk(child)

    walk(catalog)
    for key, operation in catalog["operations"].items():
        expected = set(re.findall(r"\{([^{}]+)\}", operation["path"]))
        actual = {p["name"] for p in operation["parameters"] if p["in"] == "path" and p.get("required")}
        if expected != actual:
            raise ValueError(f"Path parameter schema mismatch: {key}")
        if operation["method"] in {"GET", "HEAD"} and "requestBody" in operation:
            raise ValueError(f"GET/HEAD request body needs source review: {key}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--source", type=Path, help=f"Clean Mattermost checkout at {audit.COMMIT}")
    mode.add_argument("--download", action="store_true", help="Download immutable upstream sources")
    mode.add_argument("--cached-source", type=Path, help="Offline source cache verified against pinned hashes")
    parser.add_argument("--cache", type=Path, default=Path("/tmp/mattermost-v11-api-audit"))
    parser.add_argument("--inventory", type=Path, default=audit.REPO_ROOT / "docs/api-coverage.json")
    parser.add_argument("--output", type=Path, default=audit.REPO_ROOT / "src/api/catalog.json")
    parser.add_argument("--check", action="store_true", help="Verify current inventory and catalog without rewriting")
    args = parser.parse_args()
    files = audit.checkout_source(args.source) if args.source else audit.cached_source(args.cached_source) if args.cached_source else audit.download_source(args.cache)
    extra = supplemental_source(args.source or args.cached_source or args.cache, args.download, bool(args.source))
    inventory = audit.build_inventory(files)
    if json.loads(args.inventory.read_text()) != inventory:
        raise ValueError("Inventory differs from pinned source/current tool mapping; regenerate audit-api-coverage.py first")
    catalog = build_catalog(files, inventory, extra)
    if args.check:
        if json.loads(args.output.read_text()) != catalog:
            raise ValueError(f"Catalog differs: {args.output}")
        print("Catalog matches immutable source, current inventory and explicit corrections.")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"operations": len(catalog["operations"]), "account_callable": inventory["counts"]["generic_callable_routes"], "schemas": len(catalog["components"]["schemas"]), "correction_groups": len(catalog["corrections"])}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"catalog generation failed: {error}", file=sys.stderr)
        sys.exit(1)
