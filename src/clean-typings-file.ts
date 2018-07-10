import * as ts from "typescript";
import { readFileSync, writeFileSync } from "fs";

interface InvalidKind { kind: ts.SyntaxKind.Unknown }
type RootStatement = {
    statements: (
        InvalidKind
        | ts.ModuleDeclaration
    )[];
};


if(process.argv.length >= 4 && process.argv[1].endsWith("clean-typings-file.js")) {
    cleanFile(process.argv[2], process.argv.slice(3));
}

export function cleanFile(path: string, rootModuleNames: string[]) {
    let replacements: {
        range: ts.TextRange;
        newText: string;
    }[] = [];

    let tsRaw = readFileSync(path).toString();
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
                    start = statement.modifiers.end;

                    let text = getText(statement.modifiers);

                    function peelOff(textToPeel: string) {
                        if(text.endsWith(textToPeel)) {
                            start = start - textToPeel.length;
                        }
                        text = text.substr(0, text.length - textToPeel.length);
                    }
                    peelOff("declare");
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

    let result = "";
    let lastSourceEnd = 0;
    replacements.sort((a, b) => a.range.pos - b.range.pos);
    for(let replacement of replacements) {
        let newEnd = replacement.range.end;
        if(newEnd > lastSourceEnd) {
            let sourceText = tsRaw.slice(lastSourceEnd, replacement.range.pos);
            result += sourceText;
            lastSourceEnd = newEnd;
        }
        result += replacement.newText;
    }
    result += tsRaw.slice(lastSourceEnd);

    writeFileSync(path, result);
}