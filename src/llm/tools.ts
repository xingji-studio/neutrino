import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_OUTPUT = 20000;
const MAX_FILE_SIZE = 200000;

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Execute a shell command in the current working directory and return its stdout/stderr.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to execute." },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the content of a text file. Returns the file content or an error.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file to read (absolute or relative to cwd)." },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file, creating or overwriting it.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file to write (absolute or relative to cwd)." },
            content: { type: "string", description: "The full content to write to the file." },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories in a directory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory to list (defaults to current working directory)." },
          },
          required: [],
        },
      },
    },
  ];
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  let result: string;
  try {
    switch (name) {
      case "run_command":
        result = await runCommand(String(args.command ?? ""));
        break;
      case "read_file":
        result = readFile(String(args.path ?? ""));
        break;
      case "write_file":
        result = writeFile(String(args.path ?? ""), String(args.content ?? ""));
        break;
      case "list_files":
        result = listFiles(String(args.path ?? ""));
        break;
      default:
        result = `[Error: unknown tool '${name}']`;
    }
  } catch (e) {
    result = `[Error: ${e instanceof Error ? e.message : String(e)}]`;
  }
  return result.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function runCommand(command: string): Promise<string> {
  return new Promise((resolve) => {
    if (!command.trim()) {
      resolve("[Error: empty command]");
      return;
    }
    exec(
      command,
      { cwd: process.cwd(), timeout: 120000, maxBuffer: MAX_OUTPUT * 4 },
      (error, stdout, stderr) => {
        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push("[stderr]\n" + stderr);
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          if (code === "ETIMEDOUT" || (error as { killed?: boolean }).killed) {
            parts.push("[Error: command timed out]");
          } else {
            const exitCode = (error as { code?: number | string }).code;
            parts.push(`[exit code: ${exitCode ?? "unknown"}]`);
          }
        }
        const output = parts.join("\n").trim();
        resolve(output ? output.slice(0, MAX_OUTPUT) : "(no output)");
      },
    );
  });
}

function readFile(p: string): string {
  const resolved = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(resolved)) return `[Error: file not found: ${resolved}]`;
  if (fs.statSync(resolved).isDirectory()) return `[Error: ${resolved} is a directory]`;
  try {
    let data = fs.readFileSync(resolved, "utf-8");
    if (data.length > MAX_FILE_SIZE) data = data.slice(0, MAX_FILE_SIZE) + "\n...[truncated]";
    return data;
  } catch (e) {
    return `[Error: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

function writeFile(p: string, content: string): string {
  const resolved = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
    return `Wrote ${content.length} characters to ${resolved}`;
  } catch (e) {
    return `[Error: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

function listFiles(p: string): string {
  const resolved = p.trim()
    ? path.isAbsolute(p)
      ? p
      : path.join(process.cwd(), p)
    : process.cwd();
  if (!fs.existsSync(resolved)) return `[Error: directory not found: ${resolved}]`;
  if (!fs.statSync(resolved).isDirectory()) return `[Error: ${resolved} is not a directory]`;
  try {
    const entries = fs
      .readdirSync(resolved)
      .map((name) => {
        const isDir = fs.statSync(path.join(resolved, name)).isDirectory();
        return name + (isDir ? "/" : "");
      })
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return entries.join("\n") || "(empty directory)";
  } catch (e) {
    return `[Error: ${e instanceof Error ? e.message : String(e)}]`;
  }
}
