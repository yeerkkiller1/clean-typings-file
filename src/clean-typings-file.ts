import * as ts from "typescript";
import { readFileSync, writeFileSync, stat } from "fs";

interface InvalidKind { kind: ts.SyntaxKind.Unknown }
type RootStatement = {
    statements: (
        InvalidKind
        | ts.ModuleDeclaration
    )[];
};


if(process.argv.length >= 4 && (process.argv[1].endsWith("clean-typings-file.js") || process.argv[1].endsWith("clean-typings-file"))) {
    cleanFile(process.argv[2], process.argv.slice(3));
}

function normalizePath(path: string) {
    return path.replace(/\\/g, "/");
}

function parseReferences(tsRaw: string): ts.TextRange[] {
    let references: ts.TextRange[] = [];

    // Parse tsRaw directly, as /// <reference... stuff isn't parsed out. This means we don't exclude block
    //  comments correctly... but... whatever.
    let lastPos = -1;
    let extendedTSRaw = "\n" + tsRaw;
    while(true) {
        let index = extendedTSRaw.indexOf("\n///", lastPos);
        if(index === -1) break;
        index += 1;
        lastPos = index;
        
        let referenceEnd = extendedTSRaw.indexOf("\n", index);
        if(extendedTSRaw[referenceEnd - 1] === "\r") {
            referenceEnd -= 1;
        }

        references.push({ pos: index - 1, end: referenceEnd - 1 });

        let reference = tsRaw.slice(index, referenceEnd);
    }

    return references;
}

function getPathReference(text: string): string|null {

    function peelStart(...peels: string[]) {
        text = text.trim();
        let index = -1;
        let peel = peels[0];
        for(let p of peels) {
            index = text.indexOf(p);
            peel = p;
            if(index === 0) break;
        }
        if(index !== 0) {
            throw new Error(`Expected text to start with string, but it did not. Text ${text} should have started with one of [${peels.join(", ")}]`);
        }
        text = text.slice(peel.length);
        text = text.trim();
        return peel;
    }
    function peelEnd(...peels: string[]) {
        text = text.trim();
        let index = -1;
        let peel = peels[0];
        for(let p of peels) {
            index = text.lastIndexOf(p);
            peel = p;
            if(index === text.length - p.length) break;
        }
        if(index !== text.length - peel.length) {
            throw new Error(`Expected text to end with string, but it did not. Text ${text} should have ended with one of [${peels.join(", ")}]`);
        }
        text = text.slice(0, -peel.length);
        text = text.trim();
        return peel;
    }

    peelStart("///");
    peelStart("<");
    peelStart("reference");
    if(peelStart("path", "types") === "types") {
        return null;
    }
    peelStart("=");
    peelStart(`"`, `'`);

    peelEnd(">");
    peelEnd("/");
    peelEnd(`"`, `'`);

    return normalizePath(text);
}

function applyReplacements(source: string, replacements: { range: ts.TextRange; newText: string; }[]): string {
    if(replacements.length === 0) {
        return source;
    }

    let result = "";
    let lastSourceEnd = 0;
    replacements.sort((a, b) => a.range.pos - b.range.pos);
    for(let replacement of replacements) {
        let newEnd = replacement.range.end;
        if(newEnd > lastSourceEnd) {
            let sourceText = source.slice(lastSourceEnd, replacement.range.pos);
            result += sourceText;
            lastSourceEnd = newEnd;
        }
        result += replacement.newText;
    }
    result += source.slice(lastSourceEnd);

    return result;
}

export function cleanFile(path: string, rootModuleNames: string[]) {
    path = normalizePath(path);

    console.log(`Cleaning file ${path}, root modules ${rootModuleNames.join(", ")}`);

    let addedReferences: { [path: string]: true } = {};
    function inlineFileReferences(path: string): string {
        let source = readFileSync(path).toString();
        let referenceRanges = parseReferences(source);

        let replacements: { range: ts.TextRange; newText: string; }[] = [];

        for(let referenceRange of referenceRanges) {
            let referenceText = source.slice(referenceRange.pos, referenceRange.end);
            let fullRefPath: string;
            {
                let referencePath = getPathReference(referenceText);
                if(referencePath === null) continue;
                fullRefPath = path.slice(0, path.lastIndexOf("/") + 1) + referencePath;
                let parts = fullRefPath.split("/");
                for(let i = 0; i < parts.length; i++) {
                    let part = parts[i];
                    if(part === "..") {
                        if(i === 0) {
                            parts.splice(i, 1);
                            i -= 1;
                        } else {
                            parts.splice(i - 1, 2);
                            i -= 2;
                        }
                    }
                }
                fullRefPath = parts.join("/");
            }
            if(fullRefPath in addedReferences) continue;
            addedReferences[fullRefPath] = true;
            let inlinedContents = inlineFileReferences(fullRefPath);
            //console.log(`Inlined ${fullRefPath}`);
            replacements.push({
                range: referenceRange,
                newText: inlinedContents,
            });
        }

        return applyReplacements(source, replacements);
    }

    let tsRaw = inlineFileReferences(path);


    let replacements: {
        range: ts.TextRange;
        newText: string;
    }[] = [];

    let file: RootStatement = ts.createSourceFile(
        "nothing",
        tsRaw,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    ) as any;

    function getText(range: { pos: number, end: number }) {
        return tsRaw.slice(range.pos, range.end);
    }


    let modules: {
        [moduleName: string]: { [providerName: string]: true };
    } = {};

    for(let statement of file.statements) {
        if(statement.kind !== ts.SyntaxKind.ModuleDeclaration) continue;
        parseModule(statement);
    }

    function parseModule(mod: ts.ModuleDeclaration) {
        if(mod.name.kind !== ts.SyntaxKind.StringLiteral) {
            console.error(`Module declaration name is not a StringLiteral. It is ${mod.name.kind}, which is unhandled`);
            return;
        }
        let modName = mod.name as ts.StringLiteral;
        if(!mod.body) return;
        let body = mod.body;
        if(body.kind !== ts.SyntaxKind.ModuleBlock) {
            console.error(`Module body is not a ModuleBlock. It is ${body.kind}, which is unhandled`);
            return;
        }

        let dependencies: { [providerName: string]: true } = {};
        
        for(let statement of body.statements) {
            if(statement.kind !== ts.SyntaxKind.ImportDeclaration) continue;
            let importStatement = statement as ts.ImportDeclaration;
            if(importStatement.moduleSpecifier) {
                // TS says, "if this is not a StringLiteral it will be a grammar error"
                let moduleSpecifier = importStatement.moduleSpecifier as ts.StringLiteral;
                dependencies[moduleSpecifier.text] = true;
            }
        }
        modules[modName.text] = dependencies;
    }

    let usedModules: { [usedModuleName: string]: true } = {};
    function addUsedModule(name: string) {
        if(usedModules[name]) return;
        usedModules[name] = true;
        for(let requiredName in (modules[name] || {})) {
            addUsedModule(requiredName);
        }
    }
    for(let modName of rootModuleNames) {
        addUsedModule(modName);
    }

    // Then loop through statements again, removing all module declarations that aren't used.
    for(let statement of file.statements) {
        if(statement.kind !== ts.SyntaxKind.ModuleDeclaration) continue;
        if(statement.name.kind !== ts.SyntaxKind.StringLiteral) {
            continue;
        }
        let modName = statement.name as ts.StringLiteral;
        if(!(modName.text in usedModules)) {

            if(statement.body) {
                let start = statement.pos;
                if(statement.modifiers && statement.modifiers.length > 0) {
                    start = statement.modifiers[0].pos;
                }
                if(statement.modifiers) {
                    let modifierLength = statement.getFullText().length - statement.getText().length;
                    start = statement.modifiers.pos + modifierLength;

                    let text = getText({ pos: start, end: statement.body.end });

                    function peelOff(textToPeel: string) {
                        if(text.endsWith(textToPeel)) {
                            start = start - textToPeel.length;
                        }
                        text = text.substr(0, text.length - textToPeel.length);
                    }
                    peelOff("\n");
                    peelOff("\r");
                }

                replacements.push({
                    range: {
                        pos: start,
                        end: statement.body.end
                    },
                    newText: ""
                });
            }
        }
    }

    if(replacements.length === 0 && Object.keys(addedReferences).length === 0) {
        console.log(`Skipping emit, as the file requires no changes.`);
        return;
    }

    let result = applyReplacements(tsRaw, replacements);
    
    writeFileSync(path, result);

    //console.log(`Added ${Object.keys(addedReferences).length} references, and made ${Object.keys(replacements).length} replacements`);
}