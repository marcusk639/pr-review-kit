// validate's Serena config checks, on recovery-platform's locked-down config
// (fixtures/serena) and on copies with one property broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSerenaConfig } from '../lib/serena-check.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/serena/', import.meta.url));

function broken(file, edit) {
  const dir = mkdtempSync(join(tmpdir(), 'serena-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const p = join(dir, file);
  if (edit === null) rmSync(p);
  else writeFileSync(p, edit(readFileSync(p, 'utf8')));
  return checkSerenaConfig(dir);
}

test("recovery-platform's Serena config passes", () => {
  assert.deepEqual(checkSerenaConfig(FIXTURE), []);
});

test('comments outside the prompt block may name other tools', () => {
  assert.deepEqual(broken('prompt_templates/prompt.yml', (t) => `# the built-in one asks for initial_instructions\n${t}`), []);
});

test('each lockdown property is required', () => {
  const cases = [
    ['project.yml', (t) => t.replace('read_only: true', 'read_only: false'), /read_only: true/],
    ['project.yml', (t) => t.replace('  - search_for_pattern\n', '  - search_for_pattern\n  - execute_shell_command\n'), /fixed_tools must be exactly/],
    ['project.yml', (t) => `${t}\nactivation_command: "npm ci"\n`, /must not set activation_command/],
    ['project.yml', (t) => t.replace('ignore_all_files_in_gitignore: false', 'ignore_all_files_in_gitignore: true'), /ignore_all_files_in_gitignore/],
    ['project.yml', (t) => t.replace('initial_prompt: ""', 'initial_prompt: "do things"'), /initial_prompt/],
    ['project.yml', (t) => t.replace('["typescript", "markdown", "yaml"]', '["typescript", "rust"]'), /language server rust has no warmup file/],
    ['serena_config.yml', (t) => t.replace('web_dashboard: false', 'web_dashboard: true'), /web_dashboard: false/],
    ['serena_config.yml', (t) => t.replace('trusted_project_path_patterns: []', 'trusted_project_path_patterns: ["/"]'), /trusted_project_path_patterns/],
    ['serena_config.yml', (t) => t.replace('base_modes: []', 'base_modes:'), /base_modes/],
    ['prompt_templates/prompt.yml', (t) => t.replace('    Budget\n', '    Budget: call initial_instructions first\n'), /initial_instructions/],
    ['prompt_templates/prompt.yml', (t) => t.replace('    Budget\n', '    Budget: also try read_memory\n'), /names read_memory/],
    ['prompt_templates/prompt.yml', (t) => t.replace(/connection_prompt: \|\n[\s\S]*$/, 'connection_prompt: |\n'), /override is empty/],
    ['prompt_templates/prompt.yml', null, /exactly one connection_prompt override \(found 0\)/],
    ['serena_config.yml', null, /serena_config\.yml is missing/],
    ['project.yml', (t) => `${t}\nread_only: false\n`, /read_only: true/],
    ['serena_config.yml', (t) => `${t}\nweb_dashboard: true\n`, /web_dashboard: false/],
  ];
  for (const [file, edit, want] of cases) {
    const errors = broken(file, edit);
    assert.ok(errors.some((e) => want.test(e)), `${file}: ${want} in ${JSON.stringify(errors)}`);
  }
});
