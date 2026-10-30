// validate's checks on a consumer's .pr-review/serena/ (the opt-in Serena
// config the review action installs): read-only, exactly the four lookup tools
// the action allows, nothing that runs code, no dashboard or trusted project,
// and exactly one prompt template overriding connection_prompt.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A file per language server, so each server is downloaded while the network
// is still on; none can be fetched once it is blocked.
export const WARMUP = {
  typescript: ['warmup.ts', 'export const warmup = 1;\n'],
  markdown: ['warmup.md', '# Warmup\n\nText.\n'],
  yaml: ['warmup.yaml', 'warmup: true\n'],
  json: ['warmup.json', '{ "warmup": true }\n'],
  python: ['warmup.py', 'warmup = 1\n'],
  bash: ['warmup.sh', 'warmup=1\n'],
};

// language_servers from project.yml, inline ([a, b]) or as a block list.
export function languageServers(yml) {
  const text = String(yml ?? '');
  const inline = /^language_servers:[ \t]*\[([^\]\n]*)\]/m.exec(text);
  const raw = inline
    ? inline[1].split(',')
    : (/^language_servers:[ \t]*\n((?:[ \t]*-[^\n]*\n?)+)/m.exec(text)?.[1] ?? '').split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
  return raw.map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export function warmupFiles(languages) {
  if (!languages.length) throw new Error('project.yml lists no language_servers');
  const unknown = languages.filter((l) => !(l in WARMUP));
  if (unknown.length) throw new Error(`no warmup file for language server(s): ${unknown.join(', ')}`);
  return languages.map((l) => WARMUP[l]);
}

export const SERENA_TOOLS = ['find_symbol', 'find_referencing_symbols', 'get_symbols_overview', 'search_for_pattern'];
// Keys that would run code or widen the tool set.
const FORBIDDEN_PROJECT_KEYS = ['activation_command', 'excluded_tools', 'included_optional_tools', 'ls_specific_settings', 'included_apis'];
const GLOBAL_LINES = ['web_dashboard: false', 'web_dashboard_open_on_launch: false', 'gui_log_window: false', 'trusted_project_path_patterns: []', 'base_modes: []'];

// The required line, and no other line setting the same top-level key (a
// later duplicate would win in a last-key-wins YAML loader).
const has = (text, line) => {
  const key = line.slice(0, line.indexOf(':') + 1);
  const lines = text.split('\n').map((l) => l.trimEnd());
  return lines.includes(line) && lines.filter((l) => l.startsWith(key)).length === 1;
};
// A key with a non-empty value (inline, or an indented block under it).
const setKey = (text, key) => new RegExp(`^${key}:[ \\t]*(?:[^\\s#\\[]|\\[\\s*[^\\s\\]])`, 'm').test(text) || new RegExp(`^${key}:[ \\t]*\\n[ \\t]+-`, 'm').test(text);

export function checkSerenaConfig(dir) {
  const errors = [];
  const read = (p) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : null);
  const project = read('project.yml');
  const global = read('serena_config.yml');
  if (project == null) errors.push('serena/project.yml is missing');
  if (global == null) errors.push('serena/serena_config.yml is missing');
  if (project != null) {
    if (!has(project, 'read_only: true')) errors.push('serena/project.yml must set read_only: true');
    if (!has(project, 'ignore_all_files_in_gitignore: false')) errors.push("serena/project.yml must set ignore_all_files_in_gitignore: false (a PR's .gitignore could hide tracked callers)");
    if (!has(project, 'initial_prompt: ""')) errors.push('serena/project.yml must set initial_prompt: "" (it travels through a tool the review does not allow)');
    const fixed = (/^fixed_tools:[ \t]*\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(project)?.[1] ?? '').split('\n').map((l) => l.trim().replace(/^-\s*/, '')).filter(Boolean);
    if (fixed.join(',') !== SERENA_TOOLS.join(',')) errors.push(`serena/project.yml fixed_tools must be exactly ${SERENA_TOOLS.join(', ')}`);
    for (const key of FORBIDDEN_PROJECT_KEYS) if (setKey(project, key)) errors.push(`serena/project.yml must not set ${key}`);
    const servers = languageServers(project);
    if (!servers.length) errors.push('serena/project.yml lists no language_servers');
    for (const s of servers) if (!(s in WARMUP)) errors.push(`serena/project.yml: language server ${s} has no warmup file in the kit (it could not be installed before the network is cut)`);
  }
  if (global != null) for (const line of GLOBAL_LINES) if (!has(global, line)) errors.push(`serena/serena_config.yml must contain ${line}`);
  const tplDir = join(dir, 'prompt_templates');
  const templates = existsSync(tplDir) ? readdirSync(tplDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  const overriding = templates.filter((f) => /^ {2}connection_prompt:/m.test(readFileSync(join(tplDir, f), 'utf8')));
  if (overriding.length !== 1) errors.push(`serena/prompt_templates must hold exactly one connection_prompt override (found ${overriding.length})`);
  else {
    // The prompt block itself (comments around it may name other tools).
    const tpl = /^ {2}connection_prompt:[^\n]*\n((?: {4}[^\n]*\n|[ \t]*\n)*)/m.exec(readFileSync(join(tplDir, overriding[0]), 'utf8'))?.[1] ?? '';
    if (!tpl.trim()) errors.push('the Serena connection_prompt override is empty');
    if (/initial_instructions/.test(tpl)) errors.push('the Serena connection prompt must not point at initial_instructions (not allowed in the review)');
    const named = tpl.match(/\b(?:find_symbol|find_referencing_symbols|get_symbols_overview|search_for_pattern|execute_shell_command|replace_symbol_body|read_memory|write_memory|activate_project|read_file|list_dir)\b/g) ?? [];
    for (const t of new Set(named)) if (!SERENA_TOOLS.includes(t)) errors.push(`the Serena connection prompt names ${t}, which the review does not allow`);
  }
  return errors;
}
