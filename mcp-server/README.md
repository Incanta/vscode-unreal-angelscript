# @incanta/angelscript-mcp

A standalone MCP server that exposes Unreal AngelScript symbols and diagnostics to AI coding agents (Claude Code, Claude Desktop, etc.). It reads its data from a per-project language cache produced by the [Unreal AngelScript VS Code extension](../).

## How it works

The server reads from one of two files in your project's `.vscode/` directory, in priority order:

1. **`.vscode/as-language.live.json`** — written continuously by the VS Code extension's language server while Unreal Editor is connected. Gitignored.
2. **`.vscode/as-language.json`** — a committed offline snapshot used by `as-check` and as a fallback when no editor is connected.

Both files share the same JSON schema, so the server treats them identically.

## Claude Code setup

In your project's `.mcp.json` (or under `mcpServers` in `~/.claude.json`):

```json
{
  "mcpServers": {
    "angelscript": {
      "command": "npx",
      "args": ["-y", "@incanta/angelscript-mcp"]
    }
  }
}
```

The server defaults to reading `<cwd>/.vscode/as-language.live.json` and `<cwd>/.vscode/as-language.json`, so it works without extra arguments when Claude Code is launched from the project root.

To point it at a different workspace:

```json
{
  "mcpServers": {
    "angelscript": {
      "command": "npx",
      "args": ["-y", "@incanta/angelscript-mcp", "--workspace", "/abs/path/to/project"]
    }
  }
}
```

You can also pass one or more explicit cache files with `--cache <path>` (repeatable). Explicit paths take precedence over `--workspace`.

## Available tools

- `angelscript_search_symbols` — substring search over types, methods, and properties
- `angelscript_get_type_info` — full type definition with members and docs
- `angelscript_get_type_methods` — methods on a type
- `angelscript_get_type_properties` — properties on a type
- `angelscript_get_function_signature` — exact signature + overloads
- `angelscript_get_type_hierarchy` — superclass chain + direct subclasses
- `angelscript_list_types` — discover types by category
- `angelscript_get_diagnostics` — current AngelScript compiler errors/warnings
