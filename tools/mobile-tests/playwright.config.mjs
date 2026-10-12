import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PYTHON = resolve(ROOT, '.venv/bin/python');
const FIXTURE_SERVER = resolve(ROOT, 'tools/mobile-tests/server.py');

export default defineConfig({
  testDir: '.',
  testMatch: 'mobile.spec.mjs',
  timeout: 20_000,
  expect: {timeout: 5_000},
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3031',
    browserName: 'chromium',
    viewport: {width: 390, height: 844},
    hasTouch: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `"${PYTHON}" "${FIXTURE_SERVER}"`,
    cwd: ROOT,
    url: 'http://127.0.0.1:3031/health',
    reuseExistingServer: false,
    timeout: 15_000,
    env: {WEBCONSOLE_MOBILE_TEST_PORT: '3031'},
  },
  outputDir: '/tmp/opencode/webconsole-mobile-playwright',
});
