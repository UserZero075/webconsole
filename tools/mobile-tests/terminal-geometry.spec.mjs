import {expect, test} from '@playwright/test';

const fixtureSession = {
  id: 'geometry-fixture', token: 'fixture-token', title: 'Geometry fixture',
  project_id: 'p1', workspace_id: 'w1', launcher: 'opencode', session_role: 'agent',
  is_active: true, state: 'working', created_at: '2026-01-01T00:00:00Z',
};

async function openFixtureTerminal(page, viewport) {
  await page.setViewportSize(viewport);
  await page.route('**/api/sessions', route => route.fulfill({json:{sessions:[fixtureSession]}}));
  await page.goto('/');
  await page.waitForFunction(() => state.selectedWorkspaceId === 'w1' && state.sessions.some(item => item.id === 'geometry-fixture'));
  await page.evaluate(() => {
    state.expandedProjects.add('p1');
    state.expandedWorkspaces.add('w1');
    renderTree();
    openTerminal(state.sessions.find(item => item.id === 'geometry-fixture'));
  });
  const handle = page.locator('#terminal-frame');
  await expect(handle).toBeVisible();
  const frame = await handle.elementHandle().then(element => element.contentFrame());
  await frame.waitForFunction(() => typeof terminal !== 'undefined' && terminal.cols >= 20 && terminal.rows >= 5);
  return frame;
}

async function writeCornerMarkers(frame) {
  await frame.evaluate(async () => {
    const cols = terminal.cols;
    const rows = terminal.rows;
    const cells = [
      [1, 1, 'A', '220;30;30'],
      [1, cols, 'B', '30;180;60'],
      [rows, 1, 'C', '30;80;220'],
      [rows, cols, 'Z', '230;190;20'],
    ];
    const output = '\x1b[?1049h\x1b[2J'
      + cells.map(([row, col, glyph, color]) =>
        `\x1b[${row};${col}H\x1b[48;2;${color}m\x1b[38;2;0;0;0m${glyph}\x1b[0m`).join('');
    await new Promise(resolve => terminal.write(output, resolve));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function measureGeometry(frame) {
  return frame.evaluate(() => {
    const rect = element => {
      const {x, y, width, height, right, bottom} = element.getBoundingClientRect();
      return {x, y, width, height, right, bottom};
    };
    const wrapper = rect(document.querySelector('#terminal-wrapper'));
    const root = rect(terminal.element);
    const screenElement = document.querySelector('.xterm-screen');
    const screen = rect(screenElement);
    const cell = terminal._core._renderService.dimensions.css.cell;
    const glyphs = Object.fromEntries(['A', 'B', 'C', 'Z'].map(glyph => {
      const span = [...screenElement.querySelectorAll('.xterm-rows span')]
        .find(element => element.textContent.includes(glyph));
      return [glyph, span ? rect(span) : null];
    }));
    return {
      cols:terminal.cols, rows:terminal.rows, cell,
      wrapper, root, screen, glyphs,
      rightGap:wrapper.right - screen.right,
      bottomGap:wrapper.bottom - screen.bottom,
    };
  });
}

async function waitForFittedDimensions(frame) {
  await expect.poll(() => frame.evaluate(() => {
    const proposed = fitAddon.proposeDimensions();
    return Boolean(proposed && proposed.cols === terminal.cols && proposed.rows === terminal.rows);
  })).toBe(true);
}

test('embedded xterm grid begins at the wrapper and exposes all four edge cells', async ({page, browser}) => {
  const frame = await openFixtureTerminal(page, {width:320, height:780});
  const viewports = [[320,780],[360,780],[390,844],[430,844],[844,390],[1920,949]];

  for (const [width, height] of viewports) {
    await page.setViewportSize({width, height});
    await waitForFittedDimensions(frame);
    await writeCornerMarkers(frame);
    const geometry = await measureGeometry(frame);
    const tolerance = 1;

    expect(geometry.root.x).toBeCloseTo(geometry.wrapper.x, 0);
    expect(geometry.root.y).toBeCloseTo(geometry.wrapper.y, 0);
    expect(Math.abs(geometry.root.width - geometry.wrapper.width)).toBeLessThanOrEqual(tolerance);
    expect(geometry.screen.x).toBeGreaterThanOrEqual(geometry.wrapper.x - tolerance);
    expect(geometry.screen.y).toBeGreaterThanOrEqual(geometry.wrapper.y - tolerance);
    expect(geometry.rightGap).toBeGreaterThanOrEqual(-tolerance);
    expect(geometry.rightGap).toBeLessThan(geometry.cell.width + tolerance);
    expect(geometry.bottomGap).toBeGreaterThanOrEqual(-tolerance);
    expect(geometry.bottomGap).toBeLessThan(geometry.cell.height + tolerance);

    for (const glyph of Object.values(geometry.glyphs)) expect(glyph, `missing visible edge glyph at ${width}x${height}`).not.toBeNull();
    for (const [name, glyph] of Object.entries(geometry.glyphs)) {
      expect(glyph.x, `${name} clipped on left`).toBeGreaterThanOrEqual(geometry.wrapper.x - tolerance);
      expect(glyph.y, `${name} clipped on top`).toBeGreaterThanOrEqual(geometry.wrapper.y - tolerance);
      expect(glyph.right, `${name} clipped on right`).toBeLessThanOrEqual(geometry.wrapper.right + tolerance);
      expect(glyph.bottom, `${name} clipped on bottom`).toBeLessThanOrEqual(geometry.wrapper.bottom + tolerance);
    }
  }

  await page.setViewportSize({width:390,height:844});
  await frame.locator('.mobile-terminal-key-drawer').evaluate(element => { element.open = true; });
  await expect(frame.locator('.mobile-terminal-key-drawer')).toHaveAttribute('open', '');
  await waitForFittedDimensions(frame);
  await writeCornerMarkers(frame);
  const withKeysOpen = await measureGeometry(frame);
  expect(withKeysOpen.root.y).toBeCloseTo(withKeysOpen.wrapper.y, 0);
  expect(withKeysOpen.glyphs.Z).not.toBeNull();

  const highDprContext = await browser.newContext({viewport:{width:390,height:844}, deviceScaleFactor:2.75});
  try {
    const highDprPage = await highDprContext.newPage();
    const highDprFrame = await openFixtureTerminal(highDprPage, {width:390,height:844});
    await waitForFittedDimensions(highDprFrame);
    await writeCornerMarkers(highDprFrame);
    const geometry = await measureGeometry(highDprFrame);
    expect(geometry.root.x).toBeCloseTo(geometry.wrapper.x, 0);
    expect(geometry.root.y).toBeCloseTo(geometry.wrapper.y, 0);
    expect(geometry.rightGap).toBeGreaterThanOrEqual(-1);
    expect(geometry.rightGap).toBeLessThan(geometry.cell.width + 1);
    expect(geometry.bottomGap).toBeGreaterThanOrEqual(-1);
    expect(geometry.bottomGap).toBeLessThan(geometry.cell.height + 1);
    for (const glyph of Object.values(geometry.glyphs)) expect(glyph).not.toBeNull();
  } finally {
    await highDprContext.close();
  }
});

test('embedded xterm viewport follows the native theme background and keeps SGR cells', async ({page}) => {
  const frame = await openFixtureTerminal(page, {width:390, height:844});
  const colors = () => frame.evaluate(() => ({
    theme:terminal._core._themeService.colors.background.css,
    viewport:getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor,
    screen:getComputedStyle(document.querySelector('.xterm-screen')).backgroundColor,
  }));
  const write = data => frame.evaluate(value => new Promise(resolve => terminal.write(value, resolve)), data);

  let state = await colors();
  expect(state.theme).toBe('#1a1a2e');
  expect(state.viewport).toBe('rgb(26, 26, 46)');
  expect(state.screen).toBe('rgba(0, 0, 0, 0)');

  await write('\x1b]11;#1e1e1e\x07');
  state = await colors();
  expect(state.theme).toBe('#1e1e1e');
  expect(state.viewport).toBe('rgb(30, 30, 30)');

  await write('\x1b]111\x07');
  state = await colors();
  expect(state.theme).toBe('#1a1a2e');
  expect(state.viewport).toBe('rgb(26, 26, 46)');

  await frame.evaluate(() => { terminal.options.theme = {...terminal.options.theme, background:'#24313f'}; });
  await expect.poll(async () => (await colors()).viewport).toBe('rgb(36, 49, 63)');
  await frame.evaluate(() => { terminal.options.theme = {...terminal.options.theme, background:'#1a1a2e'}; });
  await expect.poll(async () => (await colors()).viewport).toBe('rgb(26, 26, 46)');

  await write('\x1b[48;2;11;22;33m\x1b[2J\x1b[HSGR');
  const cellBackground = await frame.locator('.xterm-rows span').filter({hasText:'SGR'}).evaluate(element => getComputedStyle(element).backgroundColor);
  expect(cellBackground).toBe('rgb(11, 22, 33)');
  expect((await colors()).viewport).toBe('rgb(26, 26, 46)');
});
