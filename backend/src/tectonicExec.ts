import { spawnSync } from 'child_process';

/**
 * Tectonic downloads TeX packages on first use; Render / cold starts need several minutes.
 * Default 5 minutes; override with TECTONIC_TIMEOUT_MS.
 */
export const TECTONIC_TIMEOUT_MS = Number(
  process.env.TECTONIC_TIMEOUT_MS || 300_000,
);

const MAX_BUFFER = 12 * 1024 * 1024;

function tectonicBin(): string {
  return process.env.TECTONIC_PATH || 'tectonic';
}

/**
 * Run tectonic without a shell (avoids quoting bugs). On failure throws Error with stderr+stdout.
 */
export function runTectonicSync(opts: {
  texPath: string;
  outdir: string;
  cwd: string;
  extraArgs?: string;
}): void {
  const { texPath, outdir, cwd, extraArgs = '' } = opts;
  const extra = extraArgs.trim().split(/\s+/).filter(Boolean);
  const args = [texPath, '--outdir', outdir, ...extra];

  const result = spawnSync(tectonicBin(), args, {
    timeout: TECTONIC_TIMEOUT_MS,
    cwd,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf-8',
    shell: false,
    env: process.env,
  });

  if (result.error) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(
        `tectonic not found (looked for "${tectonicBin()}"). Local dev: install with \`brew install tectonic\` or set TECTONIC_PATH to the binary.`,
      );
    }
    throw new Error(e.message || String(result.error));
  }

  if (result.status !== 0 && result.signal) {
    throw new Error(
      `tectonic killed by signal ${result.signal}\n${result.stderr || ''}\n${result.stdout || ''}`,
    );
  }

  if (result.status !== 0) {
    const combined = [result.stderr, result.stdout].filter(Boolean).join('\n--- stdout ---\n');
    const tail = combined.trim().slice(-8000) || `tectonic exited with code ${result.status}`;
    throw new Error(tail);
  }
}

/** Log once at startup if tectonic is missing or broken. */
export function logTectonicHealth(): void {
  const r = spawnSync(tectonicBin(), ['--version'], {
    encoding: 'utf-8',
    shell: false,
    timeout: 5000,
  });
  if (r.status !== 0 || r.error) {
    console.error(
      '\n⚠️  [tectonic] Not working or not in PATH. PDF compile will fail until you install tectonic (e.g. `brew install tectonic`) or set TECTONIC_PATH.\n',
    );
  } else {
    console.log('[tectonic]', (r.stdout || '').trim());
  }
}
