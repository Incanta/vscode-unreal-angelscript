/* --------------------------------------------------------------------------------------------
 * A small REST API that exposes the VS Code debugger to an external (AI) agent.
 *
 * It is OFF by default and started/stopped via the "Angelscript: Start/Stop Debugger Server"
 * commands. The server only binds to localhost and performs no authentication, so it is only
 * intended for use by tooling running on the same machine.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as vscode from 'vscode';
import * as http from 'http';
import { URL } from 'url';

const HOST = '127.0.0.1';

interface SessionInfo {
    id: string;
    name: string;
    type: string;
    workspaceFolder: string | null;
    configuration: vscode.DebugConfiguration;
}

export class DebuggerServer {
    private server?: http.Server;
    private disposables: vscode.Disposable[] = [];

    // Tracks every debug session VS Code currently knows about, keyed by session id.
    private sessions = new Map<string, vscode.DebugSession>();
    // Tracks which sessions are currently stopped (paused) at a breakpoint/step.
    private stoppedSessions = new Set<string>();

    // Status bar indicator: a lightning bolt while the server is running, hidden when stopped.
    private statusBarItem: vscode.StatusBarItem;

    // Dedicated Output channel so request activity is visible in the VS Code "Output" panel.
    private output: vscode.OutputChannel;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        // Clicking the indicator stops the server.
        this.statusBarItem.command = 'angelscript.stopDebuggerServer';
        this.updateStatusBar();

        this.output = vscode.window.createOutputChannel('Angelscript Debugger Server');
    }

    /** Append a timestamped line to the debugger server's Output channel. */
    private log(message: string) {
        const now = new Date().toISOString();
        this.output.appendLine(`[${now}] ${message}`);
    }

    private updateStatusBar() {
        if (this.running) {
            this.statusBarItem.text = '$(zap) AS Debugger';
            this.statusBarItem.tooltip = `Angelscript debugger server running on http://${HOST}:${this.port} — click to stop`;
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    public get running(): boolean {
        return this.server !== undefined;
    }

    public get port(): number {
        return vscode.workspace.getConfiguration("UnrealAngelscript").get<number>("debuggerServer.port", 20500);
    }

    /**
     * Start listening. Resolves once the server is bound, rejects on error (e.g. port in use).
     */
    public start(): Promise<number> {
        if (this.server) {
            return Promise.resolve(this.port);
        }

        // Track debug sessions so we can report state and stop them by id.
        this.disposables.push(
            vscode.debug.onDidStartDebugSession(session => {
                this.sessions.set(session.id, session);
            }),
            vscode.debug.onDidTerminateDebugSession(session => {
                this.sessions.delete(session.id);
                this.stoppedSessions.delete(session.id);
            }),
            // The debug adapter tracker lets us observe DAP 'stopped'/'continued' events,
            // which is the only way to know whether a session is paused.
            vscode.debug.registerDebugAdapterTrackerFactory('*', {
                createDebugAdapterTracker: (session: vscode.DebugSession) => {
                    return {
                        onDidSendMessage: (message: any) => {
                            if (message.type === 'event') {
                                if (message.event === 'stopped') {
                                    this.stoppedSessions.add(session.id);
                                } else if (message.event === 'continued') {
                                    this.stoppedSessions.delete(session.id);
                                }
                            }
                        },
                    };
                },
            }),
        );

        // Pick up any sessions that already existed before we started.
        if (vscode.debug.activeDebugSession) {
            const active = vscode.debug.activeDebugSession;
            this.sessions.set(active.id, active);
        }

        const port = this.port;

        return new Promise<number>((resolve, reject) => {
            const server = http.createServer((req, res) => this.handleRequest(req, res));

            server.on('error', (err: NodeJS.ErrnoException) => {
                // Only surface startup errors via the promise; runtime errors are logged.
                if (!this.server) {
                    reject(err);
                } else {
                    console.error("Angelscript debugger server error:", err);
                }
            });

            server.listen(port, HOST, () => {
                this.server = server;
                this.updateStatusBar();
                const address = `http://${HOST}:${port}`;
                console.log(`Angelscript debugger server listening on ${address}`);
                this.log(`Server listening on ${address}`);
                resolve(port);
            });
        });
    }

    public stop(): Promise<void> {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
        this.sessions.clear();
        this.stoppedSessions.clear();

        return new Promise<void>(resolve => {
            if (!this.server) {
                resolve();
                return;
            }
            const server = this.server;
            this.server = undefined;
            this.updateStatusBar();
            this.log('Server stopped');
            server.close(() => resolve());
        });
    }

    public dispose() {
        // Fire-and-forget; used on extension deactivation / VS Code shutdown.
        void this.stop();
        this.statusBarItem.dispose();
        this.output.dispose();
    }

    // ----------------------------------------------------------------------------------------
    // Request handling
    // ----------------------------------------------------------------------------------------

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        // Permissive CORS so a local agent/browser tool can call without ceremony.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        let url: URL;
        try {
            url = new URL(req.url ?? '/', `http://${HOST}`);
        } catch {
            this.log(`<- 400 ${req.method} ${req.url ?? ''} (invalid URL)`);
            this.sendJson(res, 400, { error: "Invalid URL" });
            return;
        }

        const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

        // Log the request, and its eventual response status once the response is finished.
        this.log(`-> ${route}`);
        res.on('finish', () => this.log(`<- ${res.statusCode} ${route}`));

        try {
            switch (route) {
                case 'GET /':
                    this.sendJson(res, 200, this.describeApi());
                    return;
                case 'GET /state':
                    this.sendJson(res, 200, this.getState());
                    return;
                case 'GET /configurations':
                    this.sendJson(res, 200, { configurations: this.getConfigurations() });
                    return;
                case 'POST /start': {
                    const body = await this.readJsonBody(req);
                    await this.handleStart(res, body);
                    return;
                }
                case 'POST /stop': {
                    const body = await this.readJsonBody(req);
                    await this.handleStop(res, body);
                    return;
                }
                default:
                    this.sendJson(res, 404, { error: `Unknown route: ${route}` });
                    return;
            }
        } catch (e) {
            this.sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
    }

    private describeApi() {
        return {
            name: "Angelscript VS Code Debugger REST API",
            endpoints: {
                "GET /state": "Current debugger state and list of active debug sessions.",
                "GET /configurations": "Launch configurations from all workspace folders.",
                "POST /start": "Start a launch configuration. Body: { \"name\": string, \"folder\"?: string }.",
                "POST /stop": "Stop debug sessions. Body: { \"sessionId\"?: string }. Omit sessionId to stop all.",
            },
        };
    }

    private getState() {
        const toInfo = (session: vscode.DebugSession): SessionInfo & { stopped: boolean } => ({
            id: session.id,
            name: session.name,
            type: session.type,
            workspaceFolder: session.workspaceFolder ? session.workspaceFolder.name : null,
            configuration: session.configuration,
            stopped: this.stoppedSessions.has(session.id),
        });

        const sessions = Array.from(this.sessions.values()).map(toInfo);
        const active = vscode.debug.activeDebugSession;

        return {
            isDebugging: sessions.length > 0,
            activeSessionId: active ? active.id : null,
            sessions,
        };
    }

    private getConfigurations() {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const result: Array<{ folder: string; name: string; type: string; request: string }> = [];

        for (const folder of folders) {
            const launch = vscode.workspace.getConfiguration('launch', folder.uri);
            const configs = launch.get<vscode.DebugConfiguration[]>('configurations') ?? [];
            for (const config of configs) {
                result.push({
                    folder: folder.name,
                    name: config.name,
                    type: config.type,
                    request: config.request,
                });
            }
        }

        // Also include any folder-less (workspace .code-workspace) configurations.
        if (folders.length === 0) {
            const launch = vscode.workspace.getConfiguration('launch');
            const configs = launch.get<vscode.DebugConfiguration[]>('configurations') ?? [];
            for (const config of configs) {
                result.push({
                    folder: '',
                    name: config.name,
                    type: config.type,
                    request: config.request,
                });
            }
        }

        return result;
    }

    private async handleStart(res: http.ServerResponse, body: any) {
        const name = body?.name;
        if (typeof name !== 'string' || name.length === 0) {
            this.sendJson(res, 400, { error: "Missing 'name' (launch configuration name) in request body." });
            return;
        }

        const folders = vscode.workspace.workspaceFolders ?? [];

        // Resolve the requested folder, if one was supplied.
        let requestedFolder: vscode.WorkspaceFolder | undefined;
        if (typeof body?.folder === 'string' && body.folder.length > 0) {
            requestedFolder = folders.find(f => f.name === body.folder || f.uri.fsPath === body.folder);
            if (!requestedFolder) {
                this.sendJson(res, 404, { error: `No workspace folder matching '${body.folder}'.` });
                return;
            }
        }

        // Find the full launch configuration OBJECT by name and pass that to startDebugging.
        // Passing the object (instead of the name string) is what lets us launch configs that
        // live in the .code-workspace "launch" section — a name string only resolves against a
        // folder's launch.json. See resolveConfiguration() for why the lookup finds them.
        this.log(`Starting launch configuration '${name}'${body?.folder ? ` in folder '${body.folder}'` : ''}`);

        const resolved = this.resolveConfiguration(name, requestedFolder);
        if (resolved) {
            this.log(`Resolved launch configuration '${name}' to folder '${resolved.folder ? resolved.folder.name : 'workspace'}'.`);
            const started = await vscode.debug.startDebugging(resolved.folder, resolved.configuration);
            this.sendJson(res, started ? 200 : 400, started
                ? { started: true, name, folder: resolved.folder ? resolved.folder.name : null }
                : { started: false, error: `VS Code refused to start launch configuration '${name}'.` });

            this.log(started ? `Successfully started debug session for configuration '${name}'.` : `Failed to start debug session for configuration '${name}'. VS Code refused the launch request.`);

            return;
        }

        this.log(`Could not find launch configuration named '${name}' in any folder or the workspace file.`);

        // Fallback: let VS Code resolve the name itself (covers anything we didn't enumerate,
        // and preserves prior behavior for folder launch.json configs).
        const fallbackFolder = requestedFolder ?? (folders.length > 0 ? folders[0] : undefined);

        this.log(`Falling back to startDebugging(folder: '${fallbackFolder ? fallbackFolder.name : 'workspace'}', name: '${name}') and hoping VS Code can resolve it by name.`);

        const started = await vscode.debug.startDebugging(fallbackFolder, name);

        this.log(started ? `Successfully started debug session for configuration '${name}' via fallback.` : `Failed to start debug session for configuration '${name}' via fallback. VS Code could not resolve the name.`);

        this.sendJson(res, started ? 200 : 404, started
            ? { started: true, name, folder: fallbackFolder ? fallbackFolder.name : null }
            : { started: false, error: `Launch configuration '${name}' not found in any workspace folder or the workspace file.` });
    }

    /**
     * Locate a launch configuration by name, returning both the configuration object and the
     * folder whose scope it should launch in (used by VS Code for ${workspaceFolder} resolution).
     *
     * getConfiguration('launch', folderUri).get('configurations') returns the MERGED set of
     * configurations visible to that folder: the folder's launch.json PLUS workspace-level
     * (.code-workspace) and user configs. That is exactly why a workspace-level config is
     * findable here even though startDebugging(folder, name) cannot resolve it by name.
     */
    private resolveConfiguration(
        name: string,
        requestedFolder: vscode.WorkspaceFolder | undefined,
    ): { configuration: vscode.DebugConfiguration; folder: vscode.WorkspaceFolder | undefined } | undefined {
        const findIn = (scope: vscode.Uri | null): vscode.DebugConfiguration | undefined => {
            const launch = vscode.workspace.getConfiguration('launch', scope);
            const configs = launch.get<vscode.DebugConfiguration[]>('configurations') ?? [];
            return configs.find(c => c && c.name === name);
        };

        // 1. Folder explicitly requested: resolve within that folder's merged scope only.
        if (requestedFolder) {
            const config = findIn(requestedFolder.uri);
            return config ? { configuration: config, folder: requestedFolder } : undefined;
        }

        // 2. Check the top (workspace / folder-less) scope as a safety net.
        const topConfig = findIn(null);
        if (topConfig) {
            return { configuration: topConfig, folder: undefined };
        }

        // 3. Search each folder's merged scope as a fallback
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            const config = findIn(folder.uri);
            if (config) {
                return { configuration: config, folder };
            }
        }

        return undefined;
    }

    private async handleStop(res: http.ServerResponse, body: any) {
        const sessionId = body?.sessionId;

        this.log(sessionId ? `Stopping debug session '${sessionId}'` : 'Stopping all debug sessions');

        if (typeof sessionId === 'string' && sessionId.length > 0) {
            const session = this.sessions.get(sessionId);
            if (!session) {
                this.log(`No active debug session with id '${sessionId}' found.`);
                this.sendJson(res, 404, { error: `No active debug session with id '${sessionId}'.` });
                return;
            }
            this.log(`Found debug session '${sessionId}' (${session.name}). Sending stop command...`);
            await vscode.debug.stopDebugging(session);
            this.sendJson(res, 200, { stopped: true, sessionId });
            return;
        }

        // No id provided: stop all sessions.
        const ids = Array.from(this.sessions.keys());
        await vscode.debug.stopDebugging(undefined);
        this.log(`Stopping all debug sessions (${ids.length} found).`);
        this.sendJson(res, 200, { stopped: true, sessionIds: ids });
    }

    // ----------------------------------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------------------------------

    private readJsonBody(req: http.IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            req.on('data', chunk => {
                size += chunk.length;
                // Guard against unbounded bodies.
                if (size > 1_000_000) {
                    reject(new Error("Request body too large."));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8').trim();
                if (raw.length === 0) {
                    resolve({});
                    return;
                }
                try {
                    resolve(JSON.parse(raw));
                } catch {
                    reject(new Error("Request body is not valid JSON."));
                }
            });
            req.on('error', reject);
        });
    }

    private sendJson(res: http.ServerResponse, status: number, payload: any) {
        const json = JSON.stringify(payload, null, 2);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(json);
    }
}
