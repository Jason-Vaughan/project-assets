import { shellExec as sh } from '../lib/git-stats.mjs';

export default function tangleclaw(dir) {
  let engines = 0;
  let routes = 0;
  try {
    engines = parseInt(
      sh(
        `grep -rio 'claude code\\|aider\\|codex\\|cursor' lib/ server.js 2>/dev/null | grep -io 'claude code\\|aider\\|codex\\|cursor' | sort -uf | wc -l | awk '{print $1}'`,
        dir,
      ) || '0',
      10,
    ) || 0;
  } catch {}
  try {
    routes = parseInt(
      sh(`grep -rE '(method|req\\.method)' lib/ server.js 2>/dev/null | wc -l | awk '{print $1}'`, dir) || '0',
      10,
    ) || 0;
  } catch {}
  return { engines, routes, npmDeps: 0 };
}
