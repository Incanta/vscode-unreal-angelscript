// Offline compilation using the as-check standalone tool.
// Spawns as-check when Unreal Editor is not connected, parses JSON output,
// and feeds diagnostics into the LSP pipeline.

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface AsCheckDiagnostic {
    uri: string;
    message: string;
    severity: "error" | "warning" | "information";
    line: number;
    character: number;
}

interface AsCheckResult {
    success: boolean;
    errors: number;
    warnings: number;
    diagnostics: AsCheckDiagnostic[];
}

export interface OfflineCheckSettings {
    enabled: boolean;
    asCheckPath: string;
    debounceMs: number;
}

let currentSettings: OfflineCheckSettings = {
    enabled: true,
    asCheckPath: "",
    debounceMs: 1000,
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;
let workspaceRoots: string[] = [];

// Tracks all URIs that have offline diagnostics so we can clear them
let offlineDiagnosticUris = new Set<string>();

export function configure(settings: OfflineCheckSettings, roots: string[]) {
    currentSettings = { ...settings };
    workspaceRoots = roots;
}

export function updateSettings(settings: Partial<OfflineCheckSettings>) {
    if (settings.enabled !== undefined) currentSettings.enabled = settings.enabled;
    if (settings.asCheckPath !== undefined) currentSettings.asCheckPath = settings.asCheckPath;
    if (settings.debounceMs !== undefined) currentSettings.debounceMs = settings.debounceMs;
}

export function isConfigured(): boolean {
    return currentSettings.enabled
        && currentSettings.asCheckPath.length > 0
        && fs.existsSync(currentSettings.asCheckPath);
}

// Cancel any pending check
export function cancel() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
}

// Clear all offline diagnostics (called when Unreal connects)
export function clearDiagnostics(
    publishCallback: (uri: string, diagnostics: Diagnostic[]) => void
) {
    for (let uri of offlineDiagnosticUris) {
        publishCallback(uri, []);
    }
    offlineDiagnosticUris.clear();
    cancel();
}

// Trigger a debounced offline check
export function triggerCheck(
    publishCallback: (uri: string, diagnostics: Diagnostic[]) => void,
    logCallback?: (message: string) => void
) {
    if (!isConfigured()) return;
    if (isRunning) return;

    cancel();
    debounceTimer = setTimeout(
        () => runCheck(publishCallback, logCallback),
        currentSettings.debounceMs
    );
}

function runCheck(
    publishCallback: (uri: string, diagnostics: Diagnostic[]) => void,
    logCallback?: (message: string) => void
) {
    if (isRunning) return;
    if (!isConfigured()) return;

    isRunning = true;

    let args = ["--json"];

    // Auto-detect database path from workspace roots
    for (let root of workspaceRoots) {
        let dbPath = path.join(root, '.vscode', 'as-language.json');
        if (fs.existsSync(dbPath)) {
            args.push("--db", dbPath);
            break;
        }
    }

    // Add script roots
    for (let root of workspaceRoots) {
        args.push("--root", root);
    }

    if (logCallback) {
        logCallback(`Running as-check: ${currentSettings.asCheckPath} ${args.join(' ')}`);
    }

    execFile(
        currentSettings.asCheckPath,
        args,
        { maxBuffer: 10 * 1024 * 1024, timeout: 60000 },
        (error, stdout, stderr) => {
            isRunning = false;

            if (!stdout || stdout.trim().length === 0) {
                if (logCallback && stderr) {
                    logCallback(`as-check stderr: ${stderr.substring(0, 500)}`);
                }
                return;
            }

            try {
                let result: AsCheckResult = JSON.parse(stdout);
                let diagnosticsByUri = new Map<string, Diagnostic[]>();

                for (let d of result.diagnostics) {
                    // Skip 'information' severity (same as Unreal diagnostic handler)
                    if (d.severity === "information") continue;

                    let uri = filePathToUri(d.uri);
                    let severity = d.severity === "error"
                        ? DiagnosticSeverity.Error
                        : DiagnosticSeverity.Warning;

                    let line = Math.max(0, d.line - 1);
                    let diagnostic: Diagnostic = {
                        severity,
                        range: {
                            start: { line, character: 0 },
                            end: { line, character: 10000 }
                        },
                        message: d.message,
                        source: 'as-check'
                    };

                    if (!diagnosticsByUri.has(uri)) {
                        diagnosticsByUri.set(uri, []);
                    }
                    diagnosticsByUri.get(uri)!.push(diagnostic);
                }

                // Clear diagnostics for URIs that no longer have errors
                for (let uri of offlineDiagnosticUris) {
                    if (!diagnosticsByUri.has(uri)) {
                        publishCallback(uri, []);
                    }
                }

                // Publish new diagnostics
                offlineDiagnosticUris.clear();
                for (let [uri, diags] of diagnosticsByUri) {
                    offlineDiagnosticUris.add(uri);
                    publishCallback(uri, diags);
                }

                if (logCallback) {
                    logCallback(
                        `as-check: ${result.errors} error(s), ${result.warnings} warning(s)`
                    );
                }
            } catch (e) {
                if (logCallback) {
                    logCallback(
                        `as-check: Failed to parse output: ${e instanceof Error ? e.message : String(e)}`
                    );
                }
            }
        }
    );
}

function filePathToUri(filePath: string): string {
    let normalized = filePath.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }
    return 'file://' + encodeURI(normalized).replace(/%3A/g, ':');
}
