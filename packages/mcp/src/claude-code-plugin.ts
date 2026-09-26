/**
 * Parts of the Claude Code plugin (plugins/firefinder) that only Claude Code
 * understands, rendered by `npm run export:claude`. claude.ai and the Messages
 * API have no hooks or slash commands, so this lives apart from
 * instructions.ts, which every client shares.
 */

/**
 * The names FireFinder's tools can have in Claude Code. The plugin's server
 * gives mcp__plugin_firefinder_firefinder__<tool>; a claude.ai connector named
 * "FireFinder" gives mcp__claude_ai_FireFinder__<tool>. Claude Code keeps only
 * one of the two when both point at the same URL, so text and permissions that
 * name a tool must work with either.
 */
export const TOOL_NAME_PREFIXES = ['mcp__plugin_firefinder_firefinder__', 'mcp__claude_ai_FireFinder__'] as const;

/**
 * Commands whose failures are usually problems other people hit too. When one
 * of them fails, the plugin's hook reminds Claude to search FireFinder; other
 * failures (grep finding nothing, a test runner) stay quiet. Claude still
 * decides: the reminder tells it to skip bugs in the code being worked on.
 * `sudo` stands in for apt and friends, which rarely run without it.
 */
export const SHARED_PROBLEM_COMMANDS = [
  // JavaScript
  'npm', 'pnpm', 'yarn', 'bun', 'node', 'deno',
  // Python
  'pip', 'pip3', 'python', 'python3', 'py', 'uv', 'poetry', 'conda',
  // Other toolchains
  'cargo', 'rustup', 'go', 'mvn', 'gradle', './gradlew', 'dotnet', 'gem', 'bundle', 'composer', 'flutter', 'pod',
  'xcodebuild', 'make', 'cmake',
  // System packages
  'sudo', 'brew', 'winget', 'choco',
  // Containers and infrastructure
  'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'terraform',
  // Deploy and cloud CLIs
  'vercel', 'netlify', 'supabase', 'firebase', 'wrangler', 'fly', 'flyctl', 'heroku', 'gcloud', 'aws', 'az',
  // Git remotes
  'git clone', 'git push', 'git pull', 'git fetch', 'ssh',
] as const;

/**
 * What Claude reads after one of those commands fails. ASCII only: on Windows
 * without Git Bash the hook runs in Windows PowerShell, whose `cat` reads
 * files in the ANSI code page.
 */
export const FAILED_COMMAND_HINT =
  'FireFinder: that command failed. If the failure is one other people plausibly hit too ' +
  '(a dependency, install, build tool, runtime or SDK version, environment, configuration, network, auth or deploy error) ' +
  'rather than a bug in the code being worked on or an expected failure such as a failing test, search FireFinder before trying fixes: ' +
  "call FireFinder's search_firefinder tool with a short generalized problem, software set to the one named product, " +
  'and the key error text with paths, usernames, hostnames and secrets removed. ' +
  'Search once per distinct problem, not after every retry. If nothing comes back, carry on without mentioning FireFinder. ' +
  "Otherwise, or if FireFinder isn't connected, ignore this note.";

/** Where the hint lives inside the plugin, relative to its root. */
export const FAILED_COMMAND_HINT_PATH = 'hooks/failed-command.json';

/**
 * hooks/hooks.json and the hint file it prints. The hook only prints a file:
 * `cat` works in bash, zsh and PowerShell (as Get-Content), so the plugin
 * needs no runtime on any platform. A permission-rule `if` holds one rule, so
 * each command gets its own handler, for the Bash and the PowerShell tool.
 */
export function renderPluginHooks(): { hooks: string; hint: string } {
  const handlers = (tool: 'Bash' | 'PowerShell') =>
    SHARED_PROBLEM_COMMANDS.map((command) => ({
      type: 'command',
      if: `${tool}(${command} *)`,
      command: `cat "\${CLAUDE_PLUGIN_ROOT}/${FAILED_COMMAND_HINT_PATH}"`,
      timeout: 10,
    }));

  const hooks = {
    description:
      'Reminds Claude to check FireFinder when a package manager, toolchain, container, deploy or git remote command fails.',
    hooks: {
      PostToolUseFailure: [
        { matcher: 'Bash', hooks: handlers('Bash') },
        { matcher: 'PowerShell', hooks: handlers('PowerShell') },
      ],
    },
  };

  const hint = {
    hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: FAILED_COMMAND_HINT },
  };

  return { hooks: `${JSON.stringify(hooks, null, 2)}\n`, hint: `${JSON.stringify(hint, null, 2)}\n` };
}
