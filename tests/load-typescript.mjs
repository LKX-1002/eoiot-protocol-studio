import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import ts from "typescript";

// Run pure protocol modules with Node's test runner without writing transpiled files.
const require = createRequire(import.meta.url);
const cache = new Map();
export function loadTypeScript(relativePath) {
  const filename = path.resolve(relativePath);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = new Module(filename);
  cache.set(filename, module);
  module.filename = filename;
  module.require = (name) =>
    name.startsWith(".")
      ? loadTypeScript(path.resolve(path.dirname(filename), `${name}.ts`))
      : require(name);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(outputText, filename);
  return module.exports;
}
