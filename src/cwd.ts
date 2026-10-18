/**
 * Helpers for deciding whether a stored session belongs to the directory the
 * agent is currently running in.
 *
 * Every agent records the working directory in its own flavour — `C:\a\b`,
 * `C:/a/b`, a trailing slash, a differently cased drive letter, or a WSL style
 * `/mnt/c/a/b` — so the comparison has to be forgiving about the spelling and
 * strict about the actual location.
 */

/** Reduce a directory path to a canonical form that can be compared for equality. */
export function normalizeCwd(dir: string): string {
  let p = (dir ?? "").trim();
  if (!p) return "";
  // The Windows long-path prefix ("\\?\C:\a") carries no meaning for us.
  p = p.replace(/^\\\\\?\\/, "");
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");

  let drive = "";
  let rest = p;
  const wslDrive = /^\/(?:mnt|cygdrive)\/([a-zA-Z])(\/.*)?$/.exec(p);
  const winDrive = /^([a-zA-Z]):(\/.*)?$/.exec(p);
  if (wslDrive) {
    drive = wslDrive[1];
    rest = wslDrive[2] ?? "/";
  } else if (winDrive) {
    drive = winDrive[1];
    rest = winDrive[2] ?? "/";
  }

  if (drive) {
    if (rest.length > 1) rest = rest.replace(/\/+$/, "");
    // Drive paths are Windows paths, which are case-insensitive.
    return `${drive.toLowerCase()}:${(rest || "/").toLowerCase()}`;
  }

  // POSIX paths are case-sensitive: only drop trailing separators.
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** True when both paths point at the same directory. Empty paths never match. */
export function sameCwd(a: string, b: string): boolean {
  const na = normalizeCwd(a);
  const nb = normalizeCwd(b);
  return na !== "" && na === nb;
}

/**
 * Claude Code names each project directory after the working directory with
 * every non-alphanumeric character replaced by a dash. That lets us attribute
 * transcripts that do not carry an explicit `cwd` field.
 */
export function claudeProjectKey(dir: string): string {
  return normalizeCwd(dir)
    .replace(/[^a-zA-Z0-9]/g, "-")
    .toLowerCase();
}
