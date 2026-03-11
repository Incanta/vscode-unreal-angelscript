import * as typedb from './database';
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

export interface ExportedDatabase {
    version: number;
    exportedAt: string;
    hasUnrealTypes: boolean;
    types: ExportedType[];
    namespaces: ExportedNamespace[];
}

export interface ExportedDiagnostics {
    version: number;
    exportedAt: string;
    diagnostics: ExportedDiagnostic[];
}

function exportProperty(prop: typedb.DBProperty): ExportedProperty {
    return {
        name: prop.name,
        typename: prop.typename,
        documentation: prop.documentation || "",
        isProtected: prop.isProtected || false,
        isPrivate: prop.isPrivate || false,
        containingTypeName: prop.containingType ? prop.containingType.name : null,
        namespaceName: prop.namespace && !prop.namespace.isRootNamespace()
            ? prop.namespace.getQualifiedNamespace() : null,
        formatted: prop.format(),
    };
}

function exportArg(arg: typedb.DBArg): ExportedArg {
    return {
        name: arg.name || null,
        typename: arg.typename,
        defaultvalue: arg.defaultvalue || null,
    };
}

function exportMethod(method: typedb.DBMethod): ExportedMethod {
    return {
        name: method.name,
        returnType: method.returnType || "void",
        args: method.args ? method.args.map(exportArg) : [],
        documentation: method.findAvailableDocumentation() || "",
        isProtected: method.isProtected || false,
        isPrivate: method.isPrivate || false,
        isConstructor: method.isConstructor || false,
        isBlueprintEvent: method.isBlueprintEvent || false,
        isCallable: method.isCallable || false,
        isMixin: method.isMixin || false,
        isOverride: method.isOverride || false,
        isConst: method.isConst || false,
        isFinal: method.isFinal || false,
        id: method.id,
        containingTypeName: method.containingType ? method.containingType.name : null,
        namespaceName: method.namespace && !method.namespace.isRootNamespace()
            ? method.namespace.getQualifiedNamespace() : null,
        formatted: method.format(),
    };
}

function exportType(dbtype: typedb.DBType): ExportedType {
    let properties: ExportedProperty[] = [];
    let methods: ExportedMethod[] = [];

    dbtype.forEachSymbol(function (symbol: typedb.DBSymbol) {
        if (symbol instanceof typedb.DBMethod) {
            methods.push(exportMethod(symbol));
        } else if (symbol instanceof typedb.DBProperty) {
            properties.push(exportProperty(symbol));
        }
    }, false);

    return {
        name: dbtype.name,
        qualifiedName: dbtype.getQualifiedTypenameInNamespace(null),
        supertype: dbtype.supertype || "",
        documentation: dbtype.documentation || "",
        isEnum: dbtype.isEnum || false,
        isStruct: dbtype.isStruct || false,
        isDelegate: dbtype.isDelegate || false,
        isEvent: dbtype.isEvent || false,
        namespaceName: dbtype.namespace && !dbtype.namespace.isRootNamespace()
            ? dbtype.namespace.getQualifiedNamespace() : null,
        properties: properties,
        methods: methods,
    };
}

export function exportDatabase(): ExportedDatabase {
    let types: ExportedType[] = [];
    let namespaces: ExportedNamespace[] = [];

    let allTypes = typedb.GetAllTypesById();
    for (let [_, dbtype] of allTypes) {
        types.push(exportType(dbtype));
    }

    let allNamespaces = typedb.GetAllNamespaces();
    for (let [_, ns] of allNamespaces) {
        if (ns.isRootNamespace())
            continue;
        let children: string[] = [];
        for (let [_, child] of ns.childNamespaces) {
            children.push(child.getQualifiedNamespace());
        }
        namespaces.push({
            name: ns.name,
            qualifiedName: ns.getQualifiedNamespace(),
            children: children,
        });
    }

    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        hasUnrealTypes: typedb.HasTypesFromUnreal(),
        types: types,
        namespaces: namespaces,
    };
}

export function writeDatabaseToFile(filePath: string): void {
    let data = exportDatabase();
    let dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

export function writeDiagnosticsToFile(filePath: string, diagnostics: ExportedDiagnostic[]): void {
    let data: ExportedDiagnostics = {
        version: 1,
        exportedAt: new Date().toISOString(),
        diagnostics: diagnostics,
    };
    let dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

export function readDatabaseFromFile(filePath: string): ExportedDatabase | null {
    try {
        if (!fs.existsSync(filePath))
            return null;
        let content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as ExportedDatabase;
    } catch (e) {
        return null;
    }
}

export function readDiagnosticsFromFile(filePath: string): ExportedDiagnostics | null {
    try {
        if (!fs.existsSync(filePath))
            return null;
        let content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as ExportedDiagnostics;
    } catch (e) {
        return null;
    }
}
