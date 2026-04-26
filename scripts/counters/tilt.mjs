import { shellExec as sh } from '../lib/git-stats.mjs';

export default function tilt(dir) {
  let endpoints = 0;
  try {
    endpoints = parseInt(
      sh(
        `find . -path '*/api/*' \\( -name 'route.ts' -o -name 'route.js' \\) | grep -v node_modules | grep -v '.next' | wc -l | awk '{print $1}'`,
        dir,
      ) || '0',
      10,
    ) || 0;
  } catch {}
  return { endpoints };
}
