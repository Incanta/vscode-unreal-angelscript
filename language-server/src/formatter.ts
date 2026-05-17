// Document formatting via prettier + prettier-plugin-angelscript.
// Loaded eagerly via require() so esbuild bundles both into the LSP output.

import * as prettier from 'prettier';
const angelscriptPlugin = require('prettier-plugin-angelscript');

export type BraceStyle = "allman" | "1tbs";
export type QuoteStyle = "double" | "single" | "preserve";
export type MetadataPerLine = "auto" | "always" | "never" | "fit";

export interface FormattingSettings {
    enabled: boolean;
    printWidth?: number;
    braceStyle?: BraceStyle;
    quoteStyle?: QuoteStyle;
    metadataPerLine?: MetadataPerLine;
    alignConsecutiveDeclarations?: boolean;
    spaceInsideAngleBrackets?: boolean;
}

let currentSettings: FormattingSettings = {
    enabled: true,
};

export function configure(settings: FormattingSettings) {
    currentSettings = { ...currentSettings, ...settings };
}

export function isEnabled(): boolean {
    return currentSettings.enabled !== false;
}

export interface FormatRequest {
    text: string;
    tabSize: number;
    insertSpaces: boolean;
    filepath?: string;
}

// Resolves the plugin's CJS module to whatever shape exports it.
function getPluginExport(): any {
    return angelscriptPlugin?.default ?? angelscriptPlugin;
}

export async function formatText(req: FormatRequest): Promise<string> {
    let plugin = getPluginExport();

    let options: prettier.Options = {
        parser: 'angelscript',
        plugins: [plugin],
        tabWidth: req.tabSize,
        useTabs: !req.insertSpaces,
        filepath: req.filepath,
    };

    if (currentSettings.printWidth !== undefined) options.printWidth = currentSettings.printWidth;

    let pluginOpts: Record<string, unknown> = {};
    if (currentSettings.braceStyle) pluginOpts.braceStyle = currentSettings.braceStyle;
    if (currentSettings.quoteStyle) pluginOpts.quoteStyle = currentSettings.quoteStyle;
    if (currentSettings.metadataPerLine) pluginOpts.metadataPerLine = currentSettings.metadataPerLine;
    if (currentSettings.alignConsecutiveDeclarations !== undefined)
        pluginOpts.alignConsecutiveDeclarations = currentSettings.alignConsecutiveDeclarations;
    if (currentSettings.spaceInsideAngleBrackets !== undefined)
        pluginOpts.spaceInsideAngleBrackets = currentSettings.spaceInsideAngleBrackets;

    return prettier.format(req.text, { ...options, ...pluginOpts });
}
