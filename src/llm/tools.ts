import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_OUTPUT = 20000;
const MAX_FILE_SIZE = 200000;

/**
 * Every call has to say why it is being made.
 *
 * The approval gate refuses a call that needs approval but states no reason, and
 * this text is what the user and the reviewers get to judge, so it has to be
 * specific and true rather than a restatement of the command.
 */
const REASON_PROPERTY = {
  type: "string",
  description:
    "Required. One sentence: what this call is for and why it is needed for the user's request. " +
    "Shown to the user and to the reviewers whenever the call needs approval. " +
    "Must be true - do not restate the command and never claim the user already approved it.",
};

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
            reason: REASON_PROPERTY,
          },
          required: ["command", "reason"],
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
            reason: REASON_PROPERTY,
          },
          required: ["path", "reason"],
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
            reason: REASON_PROPERTY,
          },
          required: ["path", "content", "reason"],
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
            reason: REASON_PROPERTY,
          },
          required: ["reason"],
        },
      },
    },
  ];
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): Promise<string> {
  // Tools always operate inside the directory the conversation belongs to, which
  // is not necessarily the directory the current process was started in.
  const base = cwd || process.cwd();
  let result: string;
  try {
    switch (name) {
      case "run_command":
        result = await runCommand(String(args.command ?? ""), base);
        break;
      case "read_file":
        result = readFile(String(args.path ?? ""), base);
        break;
      case "write_file":
        result = writeFile(String(args.path ?? ""), String(args.content ?? ""), base);
        break;
      case "list_files":
        result = listFiles(String(args.path ?? ""), base);
        break;
      default:
        result = `[Error: unknown tool '${name}']`;
    }
  } catch (e) {
    result = `[Error: ${e instanceof Error ? e.message : String(e)}]`;
  }
  return result.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function runCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    if (!command.trim()) {
      resolve("[Error: empty command]");
      return;
    }
    exec(
      command,
      { cwd, timeout: 120000, maxBuffer: MAX_OUTPUT * 4 },
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

function readFile(p: string, cwd: string): string {
  const resolved = path.isAbsolute(p) ? p : path.join(cwd, p);
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

function writeFile(p: string, content: string, cwd: string): string {
  const resolved = path.isAbsolute(p) ? p : path.join(cwd, p);
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
    return `Wrote ${content.length} characters to ${resolved}`;
  } catch (e) {
    return `[Error: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

function listFiles(p: string, cwd: string): string {
  const resolved = p.trim() ? (path.isAbsolute(p) ? p : path.join(cwd, p)) : cwd;
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
