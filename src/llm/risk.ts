/**
 * Tool-call risk assessment.
 *
 * The agent may run shell commands and touch files. Everything it does is
 * classified here before it happens, so the caller can decide whether the user
 * has to approve it:
 *
 *   - `high`    — commands that can escalate privileges, install software,
 *                 rewrite history, talk to the network, or touch anything
 *                 outside the working directory.
 *   - `extreme` — delete-class commands: they destroy data with no undo.
 *
 * Everything else returns `null` and runs unsupervised.
 */
import os from "node:os";
import path from "node:path";

export type RiskLevel = "high" | "extreme";

export interface RiskAssessment {
  level: RiskLevel;
  /** Tool that was called. */
  tool: string;
  /** One-line description of what is about to happen. */
  summary: string;
  /** Why this was flagged. Shown to the user (and to the AI reviewer). */
  reasons: string[];
}

/** Wrappers that merely delegate to the command that follows them. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "runas",
  "pkexec",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "nice",
  "ionice",
  "stdbuf",
  "xargs",
  "env",
  "watch",
  "timeout",
  "strace",
  "ltrace",
  "busybox",
]);

/** Head commands that destroy data. */
const DELETION_HEADS = new Map<string, string>([
  ["rm", "deletes files or directories (rm)"],
  ["rmdir", "removes directories (rmdir)"],
  ["del", "deletes files (del)"],
  ["erase", "deletes files (erase)"],
  ["rd", "removes directories (rd)"],
  ["shred", "overwrites and deletes files (shred)"],
  ["wipe", "destroys data (wipe)"],
  ["unlink", "removes a file (unlink)"],
  ["mkfs", "formats a filesystem (mkfs)"],
  ["format", "formats a disk (format)"],
  ["fdisk", "repartitions a disk (fdisk)"],
  ["diskpart", "repartitions a disk (diskpart)"],
  ["srm", "securely deletes files (srm)"],
  ["remove-item", "deletes files or directories (Remove-Item)"],
  ["clear-content", "empties a file (Clear-Content)"],
]);

/** Head commands that need a human (or a reviewer) to look at them. */
const HIGH_RISK_HEADS = new Map<string, string>([
  ["sudo", "escalates privileges (sudo)"],
  ["su", "switches user (su)"],
  ["doas", "escalates privileges (doas)"],
  ["runas", "escalates privileges (runas)"],
  ["pkexec", "escalates privileges (pkexec)"],
  ["visudo", "edits the sudoers policy (visudo)"],
  ["chmod", "changes file permissions (chmod)"],
  ["chown", "changes file ownership (chown)"],
  ["chgrp", "changes file group (chgrp)"],
  ["setcap", "changes process capabilities (setcap)"],
  ["systemctl", "controls system services (systemctl)"],
  ["service", "controls system services (service)"],
  ["launchctl", "controls system services (launchctl)"],
  ["sc", "controls system services (sc)"],
  ["reg", "edits the Windows registry (reg)"],
  ["shutdown", "shuts the machine down (shutdown)"],
  ["reboot", "reboots the machine (reboot)"],
  ["poweroff", "powers the machine off (poweroff)"],
  ["halt", "halts the machine (halt)"],
  ["kill", "kills a process (kill)"],
  ["pkill", "kills processes by name (pkill)"],
  ["killall", "kills processes by name (killall)"],
  ["taskkill", "kills processes (taskkill)"],
  ["apt", "installs or removes system packages (apt)"],
  ["apt-get", "installs or removes system packages (apt-get)"],
  ["yum", "installs or removes system packages (yum)"],
  ["dnf", "installs or removes system packages (dnf)"],
  ["pacman", "installs or removes system packages (pacman)"],
  ["apk", "installs or removes system packages (apk)"],
  ["brew", "installs or removes system packages (brew)"],
  ["snap", "installs or removes system packages (snap)"],
  ["pip", "installs Python packages (pip)"],
  ["pip3", "installs Python packages (pip3)"],
  ["conda", "changes the Python environment (conda)"],
  ["gem", "installs Ruby packages (gem)"],
  ["npm", "changes Node packages (npm)"],
  ["pnpm", "changes Node packages (pnpm)"],
  ["yarn", "changes Node packages (yarn)"],
  ["cargo", "changes Rust packages (cargo)"],
  ["dotnet", "changes .NET packages (dotnet)"],
  ["docker", "controls containers (docker)"],
  ["podman", "controls containers (podman)"],
  ["kubectl", "controls a cluster (kubectl)"],
  ["helm", "controls a cluster (helm)"],
  ["terraform", "changes infrastructure (terraform)"],
  ["ansible", "changes remote machines (ansible)"],
  ["crontab", "edits scheduled jobs (crontab)"],
  ["schtasks", "edits scheduled jobs (schtasks)"],
  ["ssh", "opens a remote shell (ssh)"],
  ["scp", "copies files over the network (scp)"],
  ["sftp", "transfers files over the network (sftp)"],
  ["rsync", "mirrors files (rsync)"],
  ["nc", "opens a raw network connection (nc)"],
  ["ncat", "opens a raw network connection (ncat)"],
  ["netcat", "opens a raw network connection (netcat)"],
  ["telnet", "opens a raw network connection (telnet)"],
  ["curl", "fetches data from the network (curl)"],
  ["wget", "fetches data from the network (wget)"],
  ["eval", "evaluates generated code (eval)"],
  ["source", "runs another script in this shell (source)"],
]);

/**
 * Subcommands of otherwise risky tools that change nothing: `npm run build`
 * is routine, `npm install` is not.
 */
const SAFE_SUBCOMMANDS = new Map<string, RegExp>([
  ["npm", /^(run|run-script|test|t|ls|list|view|info|outdated|audit|config|why|root|prefix|help|--version|-v)$/],
  ["pnpm", /^(run|test|ls|list|why|audit|help|--version|-v)$/],
  ["yarn", /^(run|test|ls|list|why|audit|help|--version|-v)$/],
  ["bun", /^(run|test|--version|-v)$/],
  ["pip", /^(list|show|freeze|help|--version|-v)$/],
  ["pip3", /^(list|show|freeze|help|--version|-v)$/],
  ["gem", /^(list|search|info|help|--version|-v)$/],
  ["cargo", /^(build|check|test|bench|run|doc|fmt|clippy|tree|metadata|help|--version|-v)$/],
  ["dotnet", /^(build|test|run|help|--version|-v)$/],
  ["conda", /^(list|info|help|--version|-v)$/],
  ["docker", /^(ps|images|logs|inspect|version|info|stats|history)$/],
  ["podman", /^(ps|images|logs|inspect|version|info)$/],
  ["kubectl", /^(get|describe|logs|version|top|explain|api-resources|config)$/],
  ["helm", /^(list|status|version|search|show|template|history)$/],
  ["terraform", /^(plan|validate|fmt|version|output|show|state\s+list)$/],
  ["brew", /^(list|info|search|doctor|--version|-v)$/],
  ["snap", /^(list|info|version|--version|-v)$/],
]);

/** Interpreters that only become dangerous with an inline program. */
const INTERPRETERS = new Set(["node", "python", "python3", "perl", "ruby", "php", "bash", "sh", "zsh", "pwsh", "powershell"]);

/** File names that carry credentials: touching them is never routine. */
const SENSITIVE_PATHS = [/(^|[\\/])\.env(\.|$)/i, /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i, /(^|[\\/])\.ssh([\\/]|$)/i, /(^|[\\/])\.git[\\/](config|hooks)([\\/]|$)/i, /(^|[\\/])\.aws[\\/]credentials$/i];

/** Remove quoted strings so `rg "rm -rf" .` is not mistaken for a deletion. */
function stripQuoted(command: string): string {
  return command
    .replace(/'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Last path segment of a token, lowercased, without a `.exe` suffix. */
function base(token: string): string {
  const name = token.split(/[\\/]/).pop() ?? token;
  return name.replace(/\.exe$/i, "").toLowerCase();
}

/** Split a command line into the tokens that actually run something. */
function segments(command: string): string[][] {
  const out: string[][] = [];
  for (const part of stripQuoted(command).replace(/\r?\n/g, ";").split(/&&|\|\||[;|&]/)) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // Skip `sudo`, `env`, `timeout 5`, `VAR=x` and friends: the real command
    // hides behind them and is what we care about.
    while (i < tokens.length) {
      const head = base(tokens[i]);
      if (WRAPPERS.has(head)) {
        i++;
        // `timeout 5 rm -rf x` — also skip the numeric argument.
        if (head === "timeout" && i < tokens.length && /^\d/.test(tokens[i])) i++;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
        i++;
        continue;
      }
      break;
    }
    if (i < tokens.length) out.push(tokens.slice(i));
  }
  return out;
}

/** `dd`/`truncate` are only destructive in specific shapes. */
function conditionalDeletion(head: string, argv: string[]): string | null {
  const joined = argv.join(" ");
  if (head === "dd") return /\bof=/.test(joined) ? "overwrites a device or file (dd)" : null;
  if (head === "truncate") return /(-s\s*0\b|--size[=\s]0\b)/.test(joined) ? "truncates a file to zero bytes (truncate)" : null;
  if (head === "docker" || head === "podman") {
    // Only the subcommand counts: `docker run --rm` deletes nothing.
    const sub = (argv[1] ?? "").toLowerCase();
    if (sub === "rm" || sub === "rmi") return "removes containers or images";
    if (sub === "system" && /prune/.test(joined)) return "prunes containers, images and volumes";
    if (sub === "volume" && /\b(rm|prune)\b/.test(argv.slice(2).join(" "))) return "removes volumes";
    return null;
  }
  if (head === "terraform") return /\bdestroy\b/.test(joined) ? "destroys managed infrastructure (terraform destroy)" : null;
  return null;
}

/** Expand `~` and resolve a token against the working directory. */
function resolvePath(token: string, cwd: string): string {
  let p = token;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

function outsideCwd(token: string, cwd: string): boolean {
  try {
    const rel = path.relative(cwd, resolvePath(token, cwd));
    return rel.startsWith("..") || path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function looksLikePath(token: string): boolean {
  const p = token.replace(/^[-@=+]+/, "").replace(/^["']|["']$/g, "");
  if (!p || p.length > 4096) return false;
  if (p === ".." || p.startsWith("../") || p.startsWith("..\\")) return true;
  if (p.startsWith("~/") || p.startsWith("~\\")) return true;
  if (p.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.includes("/../") || p.includes("\\..\\")) return true;
  return false;
}

function sensitiveMatch(token: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(token));
}

/** Score a shell command. */
export function assessCommand(command: string, cwd: string): { level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  let level: RiskLevel = "high";
  const plain = stripQuoted(command);
  const lower = plain.toLowerCase();

  for (const argv of segments(command)) {
    const head = base(argv[0]);

    const deletion = DELETION_HEADS.get(head);
    if (deletion) {
      reasons.push(deletion);
      level = "extreme";
    }
    const conditional = conditionalDeletion(head, argv);
    if (conditional) {
      reasons.push(conditional);
      level = "extreme";
    }
    const risky = HIGH_RISK_HEADS.get(head);
    if (risky && !reasons.includes(risky)) {
      const safe = SAFE_SUBCOMMANDS.get(head);
      const sub = (argv[1] ?? "").toLowerCase();
      if (!safe || !safe.test(sub)) reasons.push(risky);
    }
    if (INTERPRETERS.has(head) && argv.slice(1).some((a) => /^-[a-z]*[ce]$|^-c$|^-e$|^-Command$/i.test(a))) {
      reasons.push(`runs an inline program (${head} -c/-e)`);
    }
    if (head === "powershell" || head === "pwsh") {
      if (/-(c|command|encodedcommand)\b/i.test(argv.join(" "))) reasons.push("runs an inline PowerShell program");
    }
  }

  if (/\b(sudo|doas|runas|pkexec)\b/i.test(lower)) {
    const reason = "escalates privileges";
    if (!reasons.some((r) => r.includes("privileges"))) reasons.push(reason);
  }

  // Deletion patterns that are not a simple command head.
  if (/\bgit\s+clean\b[^;|&]*\s-[a-z]*f/i.test(lower)) {
    reasons.push("deletes untracked files (git clean -f)");
    level = "extreme";
  }
  if (/\bgit\s+reset\s+--hard\b/i.test(lower)) {
    reasons.push("discards uncommitted work (git reset --hard)");
    level = "extreme";
  }
  if (/\bgit\s+rm\b/i.test(lower)) {
    reasons.push("removes tracked files (git rm)");
    level = "extreme";
  }
  if (/\bgit\s+branch\s+-D\b/i.test(lower)) {
    reasons.push("force-deletes a branch (git branch -D)");
    level = "extreme";
  }
  if (/\bfind\b[^;|&]*-delete\b/i.test(lower)) {
    reasons.push("deletes every match of a find query (find -delete)");
    level = "extreme";
  }
  if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(lower)) {
    reasons.push("drops or empties a database object");
    level = "extreme";
  }
  if (/\b(shred|dd)\b[^;|&]*(of=|if=)/i.test(lower) && !reasons.some((r) => r.includes("dd"))) {
    reasons.push("writes raw bytes over a device or file");
    level = "extreme";
  }

  // Destructive-but-recoverable and history rewriting.
  if (/\bgit\s+push\b/i.test(lower)) reasons.push("publishes commits to a remote (git push)");
  if (/\bgit\s+push\b[^;|&]*--force\b/i.test(lower)) reasons.push("force-pushes and can drop remote commits");
  if (/\bgit\s+(reset|checkout|restore)\b/i.test(lower) && !reasons.some((r) => r.includes("reset --hard"))) {
    reasons.push("can discard uncommitted changes (git reset/checkout/restore)");
  }
  if (/\bgit\s+(rebase|filter-branch)\b/i.test(lower)) reasons.push("rewrites history (git rebase/filter-branch)");
  if (/(^|[^<])>{1,2}\s*\S/.test(plain)) reasons.push("redirects output into a file (>)");
  if (/\bnpm\s+(publish|unpublish)\b/i.test(lower)) reasons.push("publishes a package to the registry");

  // Anything pointing outside the working directory.
  for (const token of plain.split(/\s+/)) {
    if (!looksLikePath(token)) continue;
    if (outsideCwd(token.replace(/^[-@=+]+/, ""), cwd)) {
      const reason = `touches a path outside the working directory: ${token}`;
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  if (sensitiveMatch(command)) reasons.push("touches credentials or repository internals");

  return { level, reasons };
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (name === "run_command") {
    const command = typeof args.command === "string" ? args.command : "";
    return command.length > 400 ? `${command.slice(0, 397)}…` : command;
  }
  const p = typeof args.path === "string" ? args.path : "";
  return p ? `${name} ${p}` : name;
}

/**
 * Classify a single tool call.
 *
 * Returns `null` when the call is routine and may run without approval.
 */
export function assessToolCall(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): RiskAssessment | null {
  const workingDir = path.resolve(cwd || process.cwd());
  const summary = summarizeArgs(name, args);

  if (name === "run_command") {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) return null;
    const { level, reasons } = assessCommand(command, workingDir);
    if (reasons.length === 0) return null;
    return { level, tool: name, summary, reasons };
  }

  if (name === "read_file" || name === "write_file" || name === "list_files") {
    const raw = typeof args.path === "string" && args.path.trim() ? args.path : ".";
    const reasons: string[] = [];
    if (outsideCwd(raw, workingDir)) {
      reasons.push(`accesses a path outside the working directory: ${raw}`);
    }
    if (name !== "list_files" && sensitiveMatch(raw)) {
      reasons.push("touches credentials or repository internals");
    }
    if (reasons.length === 0) return null;
    return { level: "high", tool: name, summary, reasons };
  }

  return null;
}
