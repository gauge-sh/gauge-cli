import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("depends only on package-local modules and Node builtins", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const check = (file: string, specifier: string) => {
    if (isBuiltin(specifier)) return;
    expect(specifier.startsWith("."), `${file}: ${specifier}`).toBe(true);
    expect(
      resolve(dirname(file), specifier).startsWith(
        root.endsWith(sep) ? root : root + sep,
      ),
    ).toBe(true);
  };
  for (const file of readdirSync(root)) {
    const path = resolve(root, file);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        check(path, node.moduleSpecifier.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        check(path, node.argument.literal.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        expect(node.arguments).toHaveLength(1);
        expect(ts.isStringLiteral(node.arguments[0])).toBe(true);
        if (ts.isStringLiteral(node.arguments[0]))
          check(path, node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
