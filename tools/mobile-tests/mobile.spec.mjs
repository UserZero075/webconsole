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

  await page.locator('#toggle-inspector').click();
  await expect(page.locator('#mobile-drawer-backdrop')).toBeVisible();
  expect(await page.evaluate(() => document.body.classList.contains('inspector-open'))).toBe(true);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('inspector');
  await page.keyboard.press('Escape');
  await expect(page.locator('#toggle-inspector')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('toggle-inspector');
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
      files: document.querySelector('#toggle-inspector').getBoundingClientRect().height,
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
  await page.locator('#terminal-drawer-toggle').click();
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
