// OUT (the model's material and outputs) and STATE_FILE (facts' trusted
// snapshot, outside the model's --add-dir) come from the workflow's Run start
// step via GITHUB_ENV. Without both, facts and publish fail closed: nothing is
// read from or written to the working directory or a guessed temp path.
export function runPaths(env = process.env) {
  return env.OUT && env.STATE_FILE ? { out: env.OUT, stateFile: env.STATE_FILE } : null;
}
