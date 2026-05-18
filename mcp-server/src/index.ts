// Using require() because TypeScript 4.x moduleResolution:"node" doesn't support
// the package.json "exports" field used by @modelcontextprotocol/sdk
/* eslint-disable @typescript-eslint/no-var-requires */
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as { McpServer: any };
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js") as { StdioServerTransport: any };
const { z } = require("zod") as { z: any };
import * as fs from 'fs';
import * as path from 'path';

import {
    LanguageCache,
    NamingConventions,
    ExportedType,
    ExportedMethod,
    ExportedProperty,
    readCache,
    LIVE_CACHE_FILENAME,
    COMMITTED_CACHE_FILENAME,
} from './cache-format';

let cachePaths: string[] = [];
let cache: LanguageCache | null = null;

function loadCache(): void {
    for (let p of cachePaths) {
        let data = readCache(p);
        if (data) {
            cache = data;
            return;
        }
    }
}

function watchCache(): void {
    for (let p of cachePaths) {
        let dir = path.dirname(p);
        if (!fs.existsSync(dir))
            continue;
        try {
            fs.watch(dir, (_event, filename) => {
                if (!filename) {
                    loadCache();
                    return;
                }
                if (filename === LIVE_CACHE_FILENAME || filename === COMMITTED_CACHE_FILENAME)
                    loadCache();
            });
        } catch {
            // best-effort; ignore unwatchable directories
        }
    }
}

function matchesFilter(name: string, filter: string): boolean {
    return name.toLowerCase().includes(filter.toLowerCase());
}

function formatMethodSignature(method: ExportedMethod): string {
    let sig = "";
    if (method.returnType) sig += method.returnType + " ";
    if (method.containingTypeName) {
        sig += method.containingTypeName + ".";
    } else if (method.namespaceName) {
        sig += method.namespaceName + "::";
    }
    sig += method.name;
    sig += "(";
    if (method.args && method.args.length > 0) {
        let argParts: string[] = [];
        for (let arg of method.args) {
            let argStr = arg.typename;
            if (arg.name) argStr += " " + arg.name;
            if (arg.defaultvalue) argStr += " = " + arg.defaultvalue;
            argParts.push(argStr);
        }
        sig += argParts.join(", ");
    }
    sig += ")";
    if (method.isConst) sig += " const";
    return sig;
}

function formatPropertySignature(prop: ExportedProperty): string {
    let sig = "";
    if (prop.isProtected) sig += "protected ";
    if (prop.isPrivate) sig += "private ";
    sig += prop.typename + " ";
    if (prop.containingTypeName) {
        sig += prop.containingTypeName + ".";
    } else if (prop.namespaceName) {
        sig += prop.namespaceName + "::";
    }
    sig += prop.name;
    return sig;
}

const CACHE_UNAVAILABLE_MESSAGE = "AngelScript language cache not available. Expected one of: " +
    "<workspace>/.vscode/as-language.live.json (written while Unreal Editor is connected) or " +
    "<workspace>/.vscode/as-language.json (committed offline snapshot).";

function formatNamingConventions(conventions: NamingConventions | undefined): string {
    let lines: string[] = [];
    lines.push("# AngelScript naming conventions");
    lines.push("");
    lines.push("These rules apply to Unreal AngelScript code. Apply them when writing new code; the symbol database returned by other tools already reflects them.");
    lines.push("");

    lines.push("## StaticClass()");
    if (!conventions) {
        lines.push("- Status unknown (no naming-conventions block in the language cache; cache may predate v2 or Unreal was never connected). Assume `MyClass::StaticClass()` is discouraged and prefer the bare class name.");
    } else if (conventions.staticClassDisallowed) {
        lines.push("- DISALLOWED. `MyClass::StaticClass()` is a hard error in this project. Use the bare class name (`MyClass`) wherever a `UClass*` is expected.");
    } else if (conventions.staticClassDeprecated) {
        lines.push("- DEPRECATED. `MyClass::StaticClass()` emits a deprecation diagnostic. Use the bare class name (`MyClass`) wherever a `UClass*` is expected.");
    } else {
        lines.push("- Allowed, but the bare class name (`MyClass`) is still the idiomatic form when a `UClass*` is expected.");
    }
    lines.push("");

    lines.push("## Blueprint function library namespaces");
    if (!conventions) {
        lines.push("- Strip rules unknown. Search the symbol database (`angelscript_search_symbols`) for the actual exported namespace before guessing.");
    } else {
        if (conventions.useScriptNameForBlueprintLibraryNamespaces) {
            lines.push("- Libraries that declare a `ScriptName` meta tag are exposed under that name. Otherwise the C++ class name is transformed by the strip rules below.");
        } else {
            lines.push("- `ScriptName` meta tags are ignored for libraries. The C++ class name is transformed by the strip rules below.");
        }

        if (conventions.blueprintLibraryNamespacePrefixesToStrip.length > 0) {
            lines.push("- Prefixes stripped from the UCLASS name: " + conventions.blueprintLibraryNamespacePrefixesToStrip.map(p => `\`${p}\``).join(", "));
        } else {
            lines.push("- No prefixes are stripped.");
        }

        if (conventions.blueprintLibraryNamespaceSuffixesToStrip.length > 0) {
            lines.push("- Suffixes stripped from the UCLASS name: " + conventions.blueprintLibraryNamespaceSuffixesToStrip.map(s => `\`${s}\``).join(", "));
        } else {
            lines.push("- No suffixes are stripped.");
        }

        lines.push("");
        lines.push("Example: with the rules above, `UKismetSystemLibrary::PrintString(...)` is called from AngelScript as `" +
            applyStripExample(conventions, "UKismetSystemLibrary") + "::PrintString(...)`.");
        lines.push("");
        lines.push("When in doubt about the AngelScript-facing name, look it up with `angelscript_search_symbols` or `angelscript_list_types`.");
    }

    return lines.join("\n");
}

function applyStripExample(conventions: NamingConventions, className: string): string {
    let name = className;
    for (let prefix of conventions.blueprintLibraryNamespacePrefixesToStrip) {
        if (name.startsWith(prefix)) {
            name = name.slice(prefix.length);
            break;
        }
    }
    for (let suffix of conventions.blueprintLibraryNamespaceSuffixesToStrip) {
        if (name.endsWith(suffix)) {
            name = name.slice(0, -suffix.length);
            break;
        }
    }
    return name || className;
}

const server = new McpServer({
    name: "angelscript-mcp",
    version: "1.0.0",
});

server.tool(
    "angelscript_get_naming_conventions",
    "Get the AngelScript naming conventions for this project. Call this BEFORE writing AngelScript code, especially when referencing UClass values (e.g., `MyClass::StaticClass()` may be deprecated) or Blueprint function library namespaces (the C++ class name is transformed; e.g., `UKismetSystemLibrary` becomes `SystemLibrary` or `System` depending on settings). Returns a short rules sheet derived from the Unreal project's settings.",
    {},
    async () => {
        loadCache();
        if (!cache) {
            return { content: [{ type: "text", text: CACHE_UNAVAILABLE_MESSAGE }] };
        }
        return { content: [{ type: "text", text: formatNamingConventions(cache.namingConventions) }] };
    }
);

server.tool(
    "angelscript_search_symbols",
    "Search for AngelScript types, functions, and properties by name. Use this to find available classes, methods, global functions, and properties in the Unreal Engine AngelScript API. Returns matching symbols with their signatures.",
    {
        query: z.string().describe("Search query to match against symbol names (case-insensitive substring match)"),
        symbolType: z.enum(["all", "types", "functions", "properties"]).optional().describe("Filter by symbol type. Default: 'all'"),
        limit: z.number().optional().describe("Maximum number of results to return. Default: 50"),
    },
    async ({ query, symbolType, limit }: any) => {
        loadCache();
        if (!cache) {
            return { content: [{ type: "text", text: CACHE_UNAVAILABLE_MESSAGE }] };
        }

        let maxResults = limit || 50;
        let filter = symbolType || "all";
        let results: string[] = [];

        for (let type of cache.types) {
            if (results.length >= maxResults) break;

            if ((filter === "all" || filter === "types") && matchesFilter(type.name, query)) {
                let kind = type.isEnum ? "enum" : type.isStruct ? "struct" : type.isDelegate ? "delegate" : type.isEvent ? "event" : "class";
                results.push(`[${kind}] ${type.qualifiedName}${type.supertype ? " : " + type.supertype : ""}`);
            }

            if (filter === "all" || filter === "functions") {
                for (let method of type.methods) {
                    if (results.length >= maxResults) break;
                    if (matchesFilter(method.name, query)) {
                        results.push(`[function] ${formatMethodSignature(method)}`);
                    }
                }
            }

            if (filter === "all" || filter === "properties") {
                for (let prop of type.properties) {
                    if (results.length >= maxResults) break;
                    if (matchesFilter(prop.name, query)) {
                        results.push(`[property] ${formatPropertySignature(prop)}`);
                    }
                }
            }
        }

        if (results.length === 0) {
            return {
                content: [{ type: "text", text: `No symbols found matching "${query}"${filter !== "all" ? ` with type filter "${filter}"` : ""}.` }],
            };
        }

        return { content: [{ type: "text", text: results.join("\n") }] };
    }
);

server.tool(
    "angelscript_get_type_info",
    "Get detailed information about a specific AngelScript type (class, struct, enum, delegate). Returns the type's full definition including its superclass, documentation, all properties, and all methods with their signatures.",
    {
        typeName: z.string().describe("The name of the type to look up (e.g., 'AActor', 'FVector', 'UObject')"),
    },
    async ({ typeName }: any) => {
        loadCache();
        if (!cache) {
            return { content: [{ type: "text", text: CACHE_UNAVAILABLE_MESSAGE }] };
        }

        let foundType: ExportedType | null = null;
        let typeNameLower = typeName.toLowerCase();
        for (let type of cache.types) {
            if (type.name.toLowerCase() === typeNameLower || type.qualifiedName.toLowerCase() === typeNameLower) {
                foundType = type;
                break;
            }
        }

        if (!foundType) {
            let suggestions: string[] = [];
            for (let type of cache.types) {
                if (matchesFilter(type.name, typeName)) {
                    suggestions.push(type.qualifiedName);
                    if (suggestions.length >= 10) break;
                }
            }
            let msg = `Type "${typeName}" not found.`;
            if (suggestions.length > 0) {
                msg += ` Did you mean one of: ${suggestions.join(", ")}?`;
            }
            return { content: [{ type: "text", text: msg }] };
        }

        let lines: string[] = [];
        let kind = foundType.isEnum ? "enum" : foundType.isStruct ? "struct" : foundType.isDelegate ? "delegate" : foundType.isEvent ? "event" : "class";
        lines.push(`${kind} ${foundType.qualifiedName}${foundType.supertype ? " : " + foundType.supertype : ""}`);

        if (foundType.documentation) {
            lines.push("");
            lines.push("Documentation:");
            lines.push(foundType.documentation);
        }

        if (foundType.properties.length > 0) {
            lines.push("");
            lines.push(`Properties (${foundType.properties.length}):`);
            for (let prop of foundType.properties) {
                let line = "  " + formatPropertySignature(prop);
                if (prop.documentation) line += "  // " + prop.documentation.split("\n")[0];
                lines.push(line);
            }
        }

        if (foundType.methods.length > 0) {
            lines.push("");
            lines.push(`Methods (${foundType.methods.length}):`);
            for (let method of foundType.methods) {
                let line = "  " + formatMethodSignature(method);
                if (method.documentation) line += "  // " + method.documentation.split("\n")[0];
                lines.push(line);
            }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
);

server.tool(
    "angelscript_get_type_methods",
    "Get all methods/functions available on a specific AngelScript type. Returns method signatures with parameters, return types, and documentation. Useful for finding what operations you can perform on a type.",
    {
        typeName: z.string().describe("The name of the type to look up methods for"),
        filter: z.string().optional().describe("Optional filter to narrow down methods by name"),
    },
    async ({ typeName, filter }: any) => {
        loadCache();
        if (!cache) {
            return { content: [{ type: "text", text: CACHE_UNAVAILABLE_MESSAGE }] };
        }

        let foundType: ExportedType | null = null;
        let typeNameLower = typeName.toLowerCase();
        for (let type of cache.types) {
            if (type.name.toLowerCase() === typeNameLower || type.qualifiedName.toLowerCase() === typeNameLower) {
                foundType = type;
                break;
            }
        }

        if (!foundType) {
            return { content: [{ type: "text", text: `Type "${typeName}" not found.` }] };
        }

        let methods = foundType.methods;
        if (filter) {
            methods = methods.filter(m => matchesFilter(m.name, filter));
        }

        if (methods.length === 0) {
            return {
                content: [{ type: "text", text: `No methods found on type "${typeName}"${filter ? ` matching "${filter}"` : ""}.` }],
            };
        }

        let lines: string[] = [];
        lines.push(`Methods on ${foundType.qualifiedName} (${methods.length}):`);
        lines.push("");
        for (let method of methods) {
            lines.push(formatMethodSignature(method));
            if (method.documentation) {
                let docLines = method.documentation.split("\n");
                for (let docLine of docLines) {
                    if (docLine.trim()) lines.push("  " + docLine.trim());
                }
                lines.push("");
            }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
);

server.tool(
    "angelscript_get_type_properties",
    "Get all properties/fields available on a specific AngelScript type. Returns property types, names, access modifiers, and documentation. Useful for understanding what data a type holds.",
    {
        typeName: z.string().describe("The name of the type to look up properties for"),
        filter: z.string().optional().describe("Optional filter to narrow down properties by name"),
    },
    async ({ typeName, filter }: any) => {
        loadCache();
        if (!cache) {
            return { content: [{ type: "text", text: CACHE_UNAVAILABLE_MESSAGE }] };
        }

        let foundType: ExportedType | null = null;
        let typeNameLower = typeName.toLowerCase();
        for (let type of cache.types) {
            if (type.name.toLowerCase() === typeNameLower || type.qualifiedName.toLowerCase() === typeNameLower) {
                foundType = type;
                break;
            }
        }

        if (!foundType) {
            return { content: [{ type: "text", text: `Type "${typeName}" not found.` }] };
        }

        let properties = foundType.properties;
        if (filter) {
            properties = properties.filter(p => matchesFilter(p.name, filter));
        }

        if (properties.length === 0) {
            return {
                content: [{ type: "text", text: `No properties found on type "${typeName}"${filter ? ` matching "${filter}"` : ""}.` }],
            };
        }

        let lines: string[] = [];
        lines.push(`Properties on ${foundType.qualifiedName} (${properties.length}):`);
        lines.push("");
        for (let prop of properties) {
            lines.push(formatPropertySignature(prop));
            if (prop.documentation) {
                lines.push("  " + prop.documentation.split("\n")[0]);
            }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
);

server.tool(
    "angelscript_get_diagnostics",
    "Get current AngelScript compiler errors and warnings. Returns all active diagnostics including file paths, line numbers, and error messages. Use this to check for compilation problems in the codebase.",
    {
        uri: z.string().optional().describe("Optional file URI to filter diagnostics for a specific file"),
        severityFilter: z.enum(["all", "error", "warning", "information"]).optional().describe("Filter by severity level. Default: 'all'"),
    },
    async ({ uri, severityFilter }: any) => {
        loadCache();
        if (!cache) {
            return { content: [{ type: "text", text: CACHE_UNAVAILABLE_MESSAGE }] };
        }

        let diagnostics = cache.diagnostics || [];

        if (uri) {
            let uriLower = uri.toLowerCase();
            diagnostics = diagnostics.filter(d => d.uri.toLowerCase().includes(uriLower));
        }

        if (severityFilter && severityFilter !== "all") {
            diagnostics = diagnostics.filter(d => d.severity === severityFilter);
        }

        if (diagnostics.length === 0) {
            return {
                content: [{ type: "text", text: "No diagnostics found" + (uri ? ` for "${uri}"` : "") + (severityFilter && severityFilter !== "all" ? ` with severity "${severityFilter}"` : "") + "." }],
            };
        }

        let lines: string[] = [];
        lines.push(`Found ${diagnostics.length} diagnostic(s):`);
        lines.push("");
        for (let diag of diagnostics) {
            let severityTag = `[${diag.severity}]`;
            let location = `${diag.uri}:${diag.line + 1}:${diag.character + 1}`;
            lines.push(`${severityTag} ${location}`);
            lines.push(`  ${diag.message}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
);

server.tool(
    "angelscript_get_function_signature",
    "Get the detailed signature and documentation for a specific function by name. Searches across all types and namespaces. Use this when you need the exact function signature, parameters with types, default values, and documentation.",
    {
        functionName: z.string().describe("The name of the function to look up"),
        typeName: z.string().optional().describe("Optional: restrict search to methods of a specific type"),
    },
    async ({ functionName, typeName }: any) => {
        loadCache();
        if (!cache) {
            return { content: [{ type: "text", text: CACHE_UNAVAILABLE_MESSAGE }] };
        }

        let functionNameLower = functionName.toLowerCase();
        let matches: { method: ExportedMethod; ownerName: string }[] = [];

        for (let type of cache.types) {
            if (typeName) {
                let typeNameLower = typeName.toLowerCase();
                if (type.name.toLowerCase() !== typeNameLower && type.qualifiedName.toLowerCase() !== typeNameLower)
                    continue;
            }

            for (let method of type.methods) {
                if (method.name.toLowerCase() === functionNameLower) {
                    matches.push({ method, ownerName: type.qualifiedName });
                }
            }
        }

        if (matches.length === 0) {
            return {
                content: [{ type: "text", text: `Function "${functionName}" not found${typeName ? ` on type "${typeName}"` : ""}.` }],
            };
        }

        let lines: string[] = [];
        if (matches.length === 1) {
            let { method, ownerName } = matches[0];
            lines.push(`Function found on ${ownerName}:`);
            lines.push("");
            lines.push(formatMethodSignature(method));
            if (method.args.length > 0) {
                lines.push("");
                lines.push("Parameters:");
                for (let arg of method.args) {
                    let line = `  ${arg.typename}`;
                    if (arg.name) line += ` ${arg.name}`;
                    if (arg.defaultvalue) line += ` = ${arg.defaultvalue}`;
                    lines.push(line);
                }
            }
            if (method.documentation) {
                lines.push("");
                lines.push("Documentation:");
                lines.push(method.documentation);
            }
            let flags: string[] = [];
            if (method.isConst) flags.push("const");
            if (method.isFinal) flags.push("final");
            if (method.isOverride) flags.push("override");
            if (method.isBlueprintEvent) flags.push("BlueprintEvent");
            if (method.isCallable) flags.push("BlueprintCallable");
            if (method.isMixin) flags.push("mixin");
            if (flags.length > 0) {
                lines.push("");
                lines.push("Modifiers: " + flags.join(", "));
            }
        } else {
            lines.push(`Found ${matches.length} overloads of "${functionName}":`);
            lines.push("");
            for (let { method, ownerName } of matches) {
                lines.push(`On ${ownerName}:`);
                lines.push("  " + formatMethodSignature(method));
                if (method.documentation) {
                    lines.push("  " + method.documentation.split("\n")[0]);
                }
                lines.push("");
            }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
);

server.tool(
    "angelscript_get_type_hierarchy",
    "Get the inheritance hierarchy for an AngelScript type. Shows the superclass chain (parents) and all known subclasses (children). Useful for understanding type relationships and finding related classes.",
    {
        typeName: z.string().describe("The name of the type to look up the hierarchy for"),
    },
    async ({ typeName }: any) => {
        loadCache();
        if (!cache) {
            return { content: [{ type: "text", text: CACHE_UNAVAILABLE_MESSAGE }] };
        }

        let foundType: ExportedType | null = null;
        let typeNameLower = typeName.toLowerCase();
        for (let type of cache.types) {
            if (type.name.toLowerCase() === typeNameLower || type.qualifiedName.toLowerCase() === typeNameLower) {
                foundType = type;
                break;
            }
        }

        if (!foundType) {
            return { content: [{ type: "text", text: `Type "${typeName}" not found.` }] };
        }

        let lines: string[] = [];

        let superChain: string[] = [];
        let currentTypeName = foundType.supertype;
        let visited = new Set<string>();
        while (currentTypeName && !visited.has(currentTypeName)) {
            visited.add(currentTypeName);
            superChain.push(currentTypeName);
            let parentType = cache.types.find(t => t.name === currentTypeName || t.qualifiedName === currentTypeName);
            if (parentType) {
                currentTypeName = parentType.supertype;
            } else {
                break;
            }
        }

        if (superChain.length > 0) {
            lines.push("Superclass chain:");
            superChain.reverse();
            for (let i = 0; i < superChain.length; i++) {
                lines.push("  ".repeat(i + 1) + superChain[i]);
            }
            lines.push("  ".repeat(superChain.length + 1) + foundType.qualifiedName + " (current)");
        } else {
            lines.push(`${foundType.qualifiedName} (no superclass)`);
        }

        let subclasses: string[] = [];
        for (let type of cache.types) {
            if (type.supertype === foundType.name || type.supertype === foundType.qualifiedName) {
                subclasses.push(type.qualifiedName);
            }
        }

        if (subclasses.length > 0) {
            lines.push("");
            lines.push(`Direct subclasses (${subclasses.length}):`);
            subclasses.sort();
            for (let sub of subclasses) {
                lines.push("  " + sub);
            }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
);

server.tool(
    "angelscript_list_types",
    "List all available AngelScript types, optionally filtered by category (classes, structs, enums, delegates, events) or by a name pattern. Useful for discovering what types are available in the API.",
    {
        category: z.enum(["all", "classes", "structs", "enums", "delegates", "events"]).optional().describe("Filter by type category. Default: 'all'"),
        filter: z.string().optional().describe("Optional name filter (case-insensitive substring match)"),
        limit: z.number().optional().describe("Maximum number of results. Default: 100"),
    },
    async ({ category, filter, limit }: any) => {
        loadCache();
        if (!cache) {
            return { content: [{ type: "text", text: CACHE_UNAVAILABLE_MESSAGE }] };
        }

        let maxResults = limit || 100;
        let cat = category || "all";
        let results: string[] = [];

        for (let type of cache.types) {
            if (results.length >= maxResults) break;

            if (cat === "classes" && (type.isEnum || type.isStruct || type.isDelegate || type.isEvent)) continue;
            if (cat === "structs" && !type.isStruct) continue;
            if (cat === "enums" && !type.isEnum) continue;
            if (cat === "delegates" && !type.isDelegate) continue;
            if (cat === "events" && !type.isEvent) continue;

            if (filter && !matchesFilter(type.name, filter)) continue;

            let kind = type.isEnum ? "enum" : type.isStruct ? "struct" : type.isDelegate ? "delegate" : type.isEvent ? "event" : "class";
            let line = `[${kind}] ${type.qualifiedName}`;
            if (type.supertype) line += " : " + type.supertype;
            if (type.documentation) line += "  // " + type.documentation.split("\n")[0];
            results.push(line);
        }

        if (results.length === 0) {
            return {
                content: [{ type: "text", text: `No types found${cat !== "all" ? ` in category "${cat}"` : ""}${filter ? ` matching "${filter}"` : ""}.` }],
            };
        }

        let header = `Found ${results.length} type(s)`;
        if (results.length >= maxResults) header += ` (limited to ${maxResults})`;
        header += ":";

        return { content: [{ type: "text", text: header + "\n\n" + results.join("\n") }] };
    }
);

function resolveCachePaths(): string[] {
    let args = process.argv.slice(2);
    let workspace: string | null = null;
    let explicit: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "--workspace" || args[i] === "-w") && i + 1 < args.length) {
            workspace = args[i + 1];
            i++;
        } else if (args[i] === "--cache" && i + 1 < args.length) {
            explicit.push(args[i + 1]);
            i++;
        }
    }

    if (explicit.length > 0)
        return explicit;

    let root = workspace ? path.resolve(workspace) : process.cwd();
    return [
        path.join(root, '.vscode', LIVE_CACHE_FILENAME),
        path.join(root, '.vscode', COMMITTED_CACHE_FILENAME),
    ];
}

async function main(): Promise<void> {
    cachePaths = resolveCachePaths();
    loadCache();
    watchCache();

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    process.stderr.write(`MCP server error: ${error}\n`);
    process.exit(1);
});
