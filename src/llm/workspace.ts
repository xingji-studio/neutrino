import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

/** Recognize an explicit confinement instruction, never permission inferred from tool output. */
export function requestsWorkspaceOnly(request: string): boolean {
  const english = /\b(?:work|operate)\s+only\s+(?:inside|within)\s+(?:(?:this|the|current|temporary|project|working)\s+)*(?:fixture|workspace|directory)\b/ig;
  for (const match of request.matchAll(english)) {
    if (!/(?:do\s+not|don't|never)\s*$/i.test(request.slice(Math.max(0, match.index! - 12), match.index))) return true;
  }
  return /(?:仅|只)(?:允许|能|可以)?在(?:当前|本|这个)?(?:项目|工作|临时)?(?:目录|工作区|文件夹)(?:内|中)(?:工作|操作|读写|执行|创建|修改)/.test(request);
}

function canonical(input: string): string {
  let cursor = path.resolve(input); const tail: string[] = [];
  // lstat sees a dangling symlink too; realpath will reject it instead of treating it as a new directory.
  while (!fs.existsSync(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Unresolved symbolic link in workspace path"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break;
    tail.unshift(path.basename(cursor)); cursor = parent;
  }
  const resolved = path.join(fs.realpathSync(cursor), ...tail);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function confined(target: string, cwd: string): boolean {
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(target)) return false;
  const expanded = target === "~" || /^~[\\/]/.test(target) ? path.join(os.homedir(), target.slice(1)) : target;
  const relative = path.relative(canonical(cwd), canonical(path.resolve(cwd, expanded)));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

const pathLike = (value: string): boolean => /^(?:\/(?!\/|\*)|[A-Za-z]:[\\/]|\.\.(?:[\\/]|$)|\.[\\/]|~(?:[\\/]|$))/.test(value) ||
  (!/[\s:]/.test(value) && /^[\w.@+-]+(?:[\\/][\w.@+-]+)*$/.test(value));
const FILE_CALLS = new Set(["readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "open", "openSync", "createReadStream", "createWriteStream", "access", "accessSync", "stat", "statSync", "lstat", "lstatSync",
  "realpath", "realpathSync", "readdir", "readdirSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "existsSync",
  "unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync", "rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync"]);
type ProgramEnvironment = { values: Map<string, string>; arrays: Map<string, string[]>; functions: Map<string, ts.FunctionLikeDeclaration>; aliases: Map<string, string> };
function programPaths(program: string, cwd: string, filename?: string): string[] {
  const paths: string[] = [];
  const initial: ProgramEnvironment = { values: new Map([["__dirname", filename ? path.dirname(filename) : cwd], ["__filename", filename ?? path.join(cwd, "[eval]")]]), arrays: new Map(), functions: new Map(), aliases: new Map() };
  const fork = (env: ProgramEnvironment): ProgramEnvironment => ({ values: new Map(env.values), arrays: new Map(env.arrays), functions: new Map(env.functions), aliases: new Map(env.aliases) });
  const name = (node: ts.Expression): string | undefined => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
  const value = (node: ts.Expression | undefined, env: ProgramEnvironment): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) return env.values.get(node.text);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return value(node.expression, env);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = value(node.left, env), right = value(node.right, env);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) { const part = value(span.expression, env); if (part === undefined) return undefined; text += part + span.literal.text; }
      return text;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(), method = node.expression.name.text;
      if (receiver === "process" && method === "cwd") return cwd;
      if (receiver === "os" && method === "tmpdir") return os.tmpdir();
      if (receiver === "os" && method === "homedir") return os.homedir();
      if (receiver === "path" && ["join", "resolve", "normalize", "dirname", "basename"].includes(method)) {
        const parts = node.arguments.map(arg => value(arg, env));
        if (parts.some(part => part === undefined)) return undefined;
        const strings = parts as string[];
        if (method === "join") return path.join(...strings);
        if (method === "resolve") return path.resolve(cwd, ...strings);
        if (method === "normalize") return path.normalize(strings[0] ?? "");
        if (method === "dirname") return path.dirname(strings[0] ?? "");
        return path.basename(strings[0] ?? "");
      }
    }
    return undefined;
  };
  const array = (node: ts.Expression | undefined, env: ProgramEnvironment): string[] | undefined => {
    if (!node) return undefined;
    if (ts.isIdentifier(node)) return env.arrays.get(node.text);
    if (ts.isArrayLiteralExpression(node) && node.elements.length <= 32) {
      const entries = node.elements.map(entry => value(entry, env));
      if (entries.every((entry): entry is string => entry !== undefined)) return entries;
    }
    return undefined;
  };
  const add = (target: string | undefined): void => { if (target !== undefined && target !== "/dev/null") paths.push(target); };
  const active = new Set<ts.Node>();
  const visit = (node: ts.Node, env: ProgramEnvironment, depth = 0): void => {
    if (depth > 12) return;
    if (ts.isBlock(node)) { const local = fork(env); for (const statement of node.statements) visit(statement, local, depth + 1); return; }
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const binding = node.initializer.declarations[0]?.name, entries = array(node.expression, env);
      if (binding && ts.isIdentifier(binding) && entries) {
        for (const entry of entries) { const local = fork(env); local.values.set(binding.text, entry); visit(node.statement, local, depth + 1); }
        return;
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) env.functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const bound = value(node.initializer, env);
      if (bound !== undefined) env.values.set(node.name.text, bound); else env.values.delete(node.name.text);
      const entries = array(node.initializer, env); if (entries) env.arrays.set(node.name.text, entries); else env.arrays.delete(node.name.text);
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) env.functions.set(node.name.text, node.initializer);
      else if (node.initializer && ts.isPropertyAccessExpression(node.initializer) && FILE_CALLS.has(node.initializer.name.text)) env.aliases.set(node.name.text, node.initializer.name.text);
    }
    if (ts.isCallExpression(node)) {
      const called = name(node.expression), method = called ? env.aliases.get(called) ?? called : undefined;
      if (method && FILE_CALLS.has(method)) {
        add(value(node.arguments[0], env));
        if (/^(?:rename|copyFile|cp)(?:Sync)?$/.test(method)) add(value(node.arguments[1], env));
      }
      if (ts.isPropertyAccessExpression(node.expression) && ["forEach", "map", "reduce", "reduceRight"].includes(node.expression.name.text)) {
        const entries = array(node.expression.expression, env), callback = node.arguments[0];
        if (entries && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          const parameter = callback.parameters[/^reduce/.test(node.expression.name.text) ? 1 : 0]?.name;
          if (parameter && ts.isIdentifier(parameter)) for (const entry of entries) {
            const local = fork(env); local.values.set(parameter.text, entry); visit(callback.body, local, depth + 1);
          }
        }
      }
      const helper = called && ts.isIdentifier(node.expression) ? env.functions.get(called) : undefined;
      if (helper?.body && !active.has(helper)) {
        active.add(helper); const local = fork(env);
        helper.parameters.forEach((parameter, i) => { if (ts.isIdentifier(parameter.name)) {
          const bound = value(node.arguments[i], env); if (bound !== undefined) local.values.set(parameter.name.text, bound); else local.values.delete(parameter.name.text);
        } });
        visit(helper.body, local, depth + 1); active.delete(helper);
      }
    }
    if (ts.isFunctionLike(node)) {
      const local = fork(env); for (const parameter of node.parameters) if (ts.isIdentifier(parameter.name)) local.values.delete(parameter.name.text);
      ts.forEachChild(node, child => visit(child, local, depth + 1));
    } else ts.forEachChild(node, child => visit(child, env, depth));
  };
  visit(ts.createSourceFile(filename ?? "workspace-command.js", program, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), initial);
  return paths;
}

/** Inspect literal shell/program paths, including quoted inline programs and heredoc bodies. */
export function commandWorkspacePaths(command: string, cwd = process.cwd(), depth = 0): string[] {
  const candidates: string[] = [];
  command = command.replace(/([^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*)\n([\s\S]*?)\n\2(?=\n|;|$)/g, (full, header: string, _end: string, body: string) => {
    if (!/\bnode\b|\bcat\b[^\n]*\.(?:c?js|mjs)\b/.test(header)) return full;
    candidates.push(...programPaths(body, cwd));
    return header;
  });
  const tokens = command.matchAll(/"(?:\\[\s\S]|[^"\\])*"|'[^']*'|`(?:\\[\s\S]|[^`\\])*`|[^\s"'`;&|<>(){},\[\]]+/g);
  for (const match of tokens) {
    const token = match[0];
    const quoted = /^["'`]/.test(token);
    const value = quoted ? token.slice(1, -1).replace(/\\(["'`\\])/g, "$1") : token;
    const segment = command.slice(0, match.index).split(/[;&|\n]/).at(-1) ?? "";
    const presentation = /^\s*(?:echo|printf)\b/.test(segment) && !/[<>]/.test(segment);
    const parts = quoted ? [value] : [value, ...(value.includes("=") ? [value.slice(value.indexOf("=") + 1)] : [])];
    for (const part of parts) {
      // /dev/null is the standard empty input/output sink, not project data.
      if (part === "/dev/null") continue;
      if (!presentation && pathLike(part)) candidates.push(part);
    }
    if (quoted && /\bnode\b[^\n;&|]*\s--?(?:e|p|eval|print)\s*$/.test(command.slice(0, match.index))) candidates.push(...programPaths(value, cwd));
    else if (quoted && depth < 3 && (!presentation || /\$\(|`/.test(value)) && /[\n;(){}<>|&]|(?:read|write|require|import)/.test(value)) candidates.push(...commandWorkspacePaths(value, cwd, depth + 1));
  }
  return [...new Set(candidates)];
}

/** Preflight for declared workspace confinement. Arbitrary programs still require the normal approval gate. */
export function workspaceViolation(name: string, args: Record<string, unknown>, cwd: string): string | undefined {
  const paths = ["write_file", "read_file", "list_files"].includes(name)
    ? [typeof args.path === "string" && args.path.trim() ? args.path : "."]
    : name === "run_command" ? commandWorkspacePaths(String(args.command ?? ""), cwd) : [];
  if (name === "run_command") {
    // A local Node helper can contain the same literal paths as an inline program.
    const command = String(args.command ?? "");
    for (const match of command.matchAll(/(?:^|[\s;&|])node\s+(?:--[\w=-]+\s+)*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
      const script = match[1].replace(/^["']|["']$/g, "");
      if (script.startsWith("-") || !/\.(?:c?js|mjs)$/.test(script)) continue;
      try {
        if (!confined(script, cwd)) { paths.push(script); continue; }
        const file = path.resolve(cwd, script);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) paths.push(...programPaths(fs.readFileSync(file, "utf8"), cwd, file));
      } catch { paths.push(script); }
    }
  }
  for (const target of paths) {
    try { if (confined(target, cwd)) continue; } catch { /* Unresolved paths fail closed. */ }
    return `Path ${JSON.stringify(target)} is outside the explicitly confined workspace ${JSON.stringify(cwd)}. Nothing ran. Use workspace-relative paths, including helper scripts, and correct only this call; do not replay completed operations.`;
  }
  return undefined;
}
