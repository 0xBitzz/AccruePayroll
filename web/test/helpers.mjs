import { readFile } from "node:fs/promises";
import ts from "typescript";

/** Compile app utilities in memory, resolving their actual source dependencies. */
export async function importSource(path) {
  const cache = new Map();
  async function compile(url) {
    const key = url.href;
    if (cache.has(key)) return cache.get(key);
    const source = await readFile(url, "utf8");
    let { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    const modules = [...new Set([...outputText.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]))];
    for (const specifier of modules) {
      const resolved = specifier.startsWith(".")
        ? await compile(new URL(`${specifier}.ts`, url))
        : import.meta.resolve(specifier);
      outputText = outputText.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(resolved)}`)
        .replaceAll(`from '${specifier}'`, `from ${JSON.stringify(resolved)}`);
    }
    const compiled = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
    cache.set(key, compiled);
    return compiled;
  }
  return import(await compile(new URL(path, import.meta.url)));
}
