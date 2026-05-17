import * as fs from 'fs';
import * as path from 'path';

export interface ExportedProperty {
    name: string;
    typename: string;
    documentation: string;
    isProtected: boolean;
    isPrivate: boolean;
    containingTypeName: string | null;
    namespaceName: string | null;
    formatted: string;
}

export interface ExportedArg {
    name: string | null;
    typename: string;
    defaultvalue: string | null;
}

export interface ExportedMethod {
    name: string;
    returnType: string;
    args: ExportedArg[];
    documentation: string;
    isProtected: boolean;
    isPrivate: boolean;
    isConstructor: boolean;
    isBlueprintEvent: boolean;
    isCallable: boolean;
    isMixin: boolean;
    isOverride: boolean;
    isConst: boolean;
    isFinal: boolean;
    id: number;
    containingTypeName: string | null;
    namespaceName: string | null;
    formatted: string;
}

export interface ExportedType {
    name: string;
    qualifiedName: string;
    supertype: string;
    documentation: string;
    isEnum: boolean;
    isStruct: boolean;
    isDelegate: boolean;
    isEvent: boolean;
    namespaceName: string | null;
    properties: ExportedProperty[];
    methods: ExportedMethod[];
}

export interface ExportedNamespace {
    name: string;
    qualifiedName: string;
    children: string[];
}

export interface ExportedDiagnostic {
    uri: string;
    message: string;
    severity: string;
    line: number;
    character: number;
}

/** Combined snapshot format shared between the live cache and the committed offline cache. */
export interface LanguageCache {
    version: number;
    exportedAt: string;
    hasUnrealTypes: boolean;
    types: ExportedType[];
    namespaces: ExportedNamespace[];
    diagnostics: ExportedDiagnostic[];
}

export const LIVE_CACHE_FILENAME = 'as-language.live.json';
export const COMMITTED_CACHE_FILENAME = 'as-language.json';

export function readCache(filePath: string): LanguageCache | null {
    try {
        if (!fs.existsSync(filePath))
            return null;
        let content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as LanguageCache;
    } catch {
        return null;
    }
}

export function writeCache(filePath: string, data: LanguageCache): void {
    let dir = path.dirname(filePath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}
