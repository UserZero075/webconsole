import {expect, test} from '@playwright/test';

async function dispatchTouch(page, {startX = 60, startY = 100, endX = startX, endY = 60, extraFinger = false}) {
  return page.evaluate(({startX, startY, endX, endY, extraFinger}) => {
    const screen = document.querySelector('.xterm-screen');
    const makeTouch = (identifier, x, y) => new Touch({
      identifier, target:screen, clientX:x, clientY:y, pageX:x, pageY:y,
    });
    const first = makeTouch(1, startX, startY);
    screen.dispatchEvent(new TouchEvent('touchstart', {
      bubbles:true, cancelable:true, touches:[first], changedTouches:[first],
    }));
    if (extraFinger) {
      const second = makeTouch(2, startX + 5, startY);
      screen.dispatchEvent(new TouchEvent('touchstart', {
        bubbles:true, cancelable:true, touches:[first, second], changedTouches:[second],
      }));
      screen.dispatchEvent(new TouchEvent('touchmove', {
        bubbles:true, cancelable:true, touches:[first, second], changedTouches:[second],
      }));
      return false;
    }
    const moved = makeTouch(1, endX, endY);
    const event = new TouchEvent('touchmove', {
      bubbles:true, cancelable:true, touches:[moved], changedTouches:[moved],
    });
    screen.dispatchEvent(event);
    screen.dispatchEvent(new TouchEvent('touchend', {
      bubbles:true, cancelable:true, touches:[], changedTouches:[moved],
    }));
    return event.defaultPrevented;
  }, {startX, startY, endX, endY, extraFinger});
}

test('normal xterm scrollback moves locally without sending input', async ({page}) => {
  await page.goto('/tests/frontend/mobile/terminal-fixture.html');
  await page.evaluate(() => fixtureWriteScrollback());
  await expect.poll(() => page.evaluate(() => terminal.buffer.active.baseY)).toBeGreaterThan(0);
  const before = await page.evaluate(() => terminal.buffer.active.viewportY);
  await dispatchTouch(page, {startY: 60, endY: 110});
  await expect.poll(() => page.evaluate(() => terminal.buffer.active.viewportY)).toBeLessThan(before);
  const state = await page.evaluate(() => fixtureReadState());
  expect(state.input).toEqual([]);
});

test('alternate-screen VT200 swipe uses only xterm wheel protocol events', async ({page}) => {
  await page.goto('/tests/frontend/mobile/terminal-fixture.html');
  await page.evaluate(() => { fixtureSetBuffer('alternate'); fixtureSetMouse('vt200'); });
  await expect.poll(() => page.evaluate(() => terminal.modes.mouseTrackingMode)).toBe('vt200');
  await page.evaluate(() => fixtureResetInput());
  const prevented = await dispatchTouch(page, {startY: 60, endY: 100});
  expect(prevented).toBe(true);
  const state = await page.evaluate(() => fixtureReadState());
  const bytes = state.input.map(item => item.data).join('');
  expect(bytes).toContain('\u001b[<64;');
  expect(bytes).not.toMatch(/\u001b\[[AB]|\r|\u0003/);
});

test('x10 and an alternate buffer without mouse tracking never become arrow input', async ({page}) => {
  await page.goto('/tests/frontend/mobile/terminal-fixture.html');
  await page.evaluate(() => { fixtureSetBuffer('alternate'); fixtureSetMouse('x10'); });
  await expect.poll(() => page.evaluate(() => terminal.modes.mouseTrackingMode)).toBe('x10');
  await page.evaluate(() => fixtureResetInput());
  await dispatchTouch(page, {startY: 60, endY: 100});
  expect((await page.evaluate(() => fixtureReadState())).input).toEqual([]);
  await page.evaluate(() => { fixtureSetMouse('none'); fixtureResetInput(); });
  await expect.poll(() => page.evaluate(() => terminal.modes.mouseTrackingMode)).toBe('none');
  await dispatchTouch(page, {startY: 60, endY: 100});
  expect((await page.evaluate(() => fixtureReadState())).input).toEqual([]);
});

test('workspace drawers close by backdrop/Escape and never focus the terminal', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await expect(page.locator('#toggle-projects')).toBeVisible();
  await page.locator('#toggle-projects').click();
  await expect(page.locator('#project-sidebar')).toHaveClass(/open/);
  await expect(page.locator('#toggle-projects')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('project-sidebar');
  await page.locator('#mobile-drawer-backdrop').click({position:{x:350,y:100}});
  await expect(page.locator('#project-sidebar')).not.toHaveClass(/open/);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('toggle-projects');

  await page.locator('[data-mobile-surface="files"]').click();
  await expect(page.locator('.explorer-section')).toBeVisible();
  await expect(page.locator('.message-section')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement.dataset.mobileSurface)).toBe('files');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.activeElement.id)).not.toMatch(/terminal-frame|shell-frame/);
});

test('320px workspace has no horizontal page overflow and keeps essential hit targets', async ({page}) => {
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({width, height: 780});
    await page.goto('/');
    await expect(page.locator('#toggle-projects')).toBeVisible();
    const metrics = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      projects: document.querySelector('#toggle-projects').getBoundingClientRect().height,
    files: document.querySelector('[data-mobile-surface="files"]').getBoundingClientRect().height,
    }));
    expect(metrics.page).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.projects).toBeGreaterThanOrEqual(40);
    expect(metrics.files).toBeGreaterThanOrEqual(40);
  }
});

test('shell drawer separator can be resized without creating a terminal', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await expect(page.locator('#terminal-drawer-toggle')).toBeEnabled();
  await page.locator('#mobile-shell-open').click();
  const separator = page.locator('#terminal-resize');
  await expect(separator).toBeVisible();
  const before = await page.locator('#workspace-terminal').evaluate(element => element.getBoundingClientRect().height);
  const box = await separator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 50, {steps:4});
  await page.mouse.up();
  await expect.poll(() => page.locator('#workspace-terminal').evaluate(element => element.getBoundingClientRect().height))
    .toBeGreaterThan(before);
  expect(await page.locator('#shell-frame').getAttribute('src')).toBeFalsy();
});

test('mobile viewport CSS receives orientation and visible-height changes', async ({page}) => {
  await page.goto('/');
  const portraitHeight = await page.evaluate(() => ({
    visible: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--webconsole-visible-height')),
    inner: window.innerHeight,
  }));
  expect(portraitHeight.visible).toBeGreaterThan(0);
  expect(Math.abs(portraitHeight.visible - portraitHeight.inner)).toBeLessThanOrEqual(1);
  await page.setViewportSize({width: 844, height: 390});
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--webconsole-visible-height'))))
    .toBeLessThan(portraitHeight.visible);
  const landscapeHeight = await page.evaluate(() => ({
    visible: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--webconsole-visible-height')),
    inner: window.innerHeight,
  }));
  expect(Math.abs(landscapeHeight.visible - landscapeHeight.inner)).toBeLessThanOrEqual(1);
});

test('mobile navigation gives Git and messages a full-height surface', async ({page}) => {
  await page.setViewportSize({width:390, height:844});
  await page.goto('/');
  await expect(page.locator('#mobile-workspace-nav')).toBeVisible();
  await expect(page.locator('[data-mobile-surface="agents"]')).toHaveAttribute('aria-current', 'page');

  await page.locator('[data-mobile-surface="git"]').click();
  await expect(page.locator('body')).toHaveClass(/mobile-surface-git/);
  await expect(page.locator('.git-section')).toBeVisible();
  await expect(page.locator('.explorer-section')).toBeHidden();

  await page.locator('[data-mobile-surface="messages"]').click();
  await expect(page.locator('body')).toHaveClass(/mobile-surface-messages/);
  await expect(page.locator('.message-section')).toBeVisible();
  await expect(page.locator('.git-section')).toBeHidden();

  await page.locator('[data-mobile-surface="files"]').click();
  await expect(page.locator('body')).toHaveClass(/mobile-files-browser/);
  await expect(page.locator('.explorer-section')).toBeVisible();
  await expect(page.locator('.message-section')).toBeHidden();
});

test('opening a file transitions from the file browser to its editor surface', async ({page}) => {
  await page.setViewportSize({width:390, height:844});
  await page.goto('/');
  await page.locator('[data-mobile-surface="files"]').click();
  await expect(page.locator('.file-entry.file')).toBeVisible();
  await page.locator('.file-entry.file').click();
  await expect(page.locator('body')).toHaveClass(/mobile-surface-files/);
  await expect(page.locator('body')).not.toHaveClass(/mobile-files-browser/);
  await expect(page.locator('.editor-view')).toBeVisible();
  await expect(page.locator('.inspector')).toBeHidden();
});

test('embedded terminal offers an explicit mobile draft without making typing live', async ({page}) => {
  await page.setViewportSize({width:390, height:844});
  await page.goto('/c/fixture-token');
  const draft = page.locator('#mobile-terminal-draft');
  const send = page.locator('#mobile-terminal-send');
  await expect(page.locator('#mobile-terminal-tools')).toBeVisible();
  await expect(draft).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(page.locator('.mobile-terminal-key-drawer')).not.toHaveAttribute('open', '');
  await expect(page.locator('#mobile-terminal-note')).toBeHidden();
  expect(await draft.evaluate(element => getComputedStyle(element).fontSize)).toBe('16px');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    origin:location.origin, source:window.parent,
    data:{type:'webconsole:session-state', session_id:'fixture-session', input_allowed:true, state:'working'},
  })));
  await draft.fill('texto aún no enviado');
  await expect(send).toBeDisabled();
  await expect(page.locator('#mobile-terminal-note')).toBeHidden();
});
