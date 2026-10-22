const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, dialog, screen } = require('electron');
const directory = process.env.CONFIRMATION_TEST_DIR;
const profile = process.env.CONFIRMATION_PROFILE_DIR;
const results = [];
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(profile, 'user-data'));

function inside(rect, area) {
  return (
    rect.x >= area.x &&
    rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height
  );
}

app
  .whenReady()
  .then(async () => {
    const { measure } = require(path.join(directory, 'measure.node'));
    const { confirmSignature } = require(path.join(directory, 'confirm.cjs'));
    const parent = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const area = screen.getDisplayMatching(parent.getBounds()).workArea;
    assert.equal(`${area.width}x${area.height}`, process.env.CONFIRMATION_WORK_AREA);
    const nativeShow = dialog.showMessageBox.bind(dialog);
    let current;
    const save = () =>
      fs.writeFileSync(path.join(profile, 'results.json'), JSON.stringify(results, null, 2));
    dialog.showMessageBox = async (owner, options) => {
      const pending = nativeShow(owner, options);
      await delay(80);
      const boxes = measure();
      assert.equal(boxes.length, 1, 'exactly one visible native confirmation');
      const box = boxes[0];
      const detail = box.labels.find((label) => label.text === options.detail);
      const heading = box.labels.find((label) => label.text === options.message);
      assert.ok(detail && heading, 'measure the exact detail and heading supplied by main');
      assert.match(detail.font, /^DejaVu Sans /);
      assert.equal(detail.dpi, 96 * Number(process.env.CONFIRMATION_TEXT_SCALE));
      const lines = box.labels.flatMap((label) =>
        label.lines.map((line) => ({
          ...line,
          allocated: inside(line, label.allocation),
        })),
      );
      const hidden = lines.filter((line) => !inside(line, area) || !line.allocated);
      const hiddenButtons = box.buttons.filter((button) => !inside(button, area));
      const fits = inside(box, area) && hidden.length === 0 && hiddenButtons.length === 0;
      current.pages.push({
        options,
        workArea: area,
        box,
        hidden,
        hiddenButtons,
        fits,
        detailRowHeights: [...new Set(detail.lines.map((line) => line.height))],
        headingRowHeights: [...new Set(heading.lines.map((line) => line.height))],
        chromeHeight:
          box.height -
          detail.lines.reduce((sum, line) => sum + line.height, 0) -
          heading.lines.reduce((sum, line) => sum + line.height, 0),
      });
      save();
      assert.equal(box.buttons.length, 2, 'both native buttons are present');
      if (current.version === 'new') {
        assert.ok(fits, `${current.name}: all text allocations and both buttons must fit`);
        assert.equal(options.defaultId, options.buttons.indexOf('Cancel'));
        assert.equal(options.cancelId, options.buttons.indexOf('Cancel'));
      }
      const ids = execFileSync('xdotool', ['search', '--onlyvisible', '--name', options.title], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n');
      const id = ids.at(-1);
      const final = options.buttons.includes('Approve & sign');
      // Baseline dialogs are measured and cancelled, including ones with hidden buttons.
      const keys =
        current.version === 'legacy' ? ['Return'] : [final ? 'Tab' : 'shift+Tab', 'Return'];
      execFileSync('xdotool', ['windowfocus', id, 'key', ...keys]);
      return pending;
    };
    const fixtures = JSON.parse(fs.readFileSync(path.join(directory, 'cases.json')));
    for (const fixture of fixtures) {
      current = { name: fixture.name, version: 'legacy', pages: [] };
      results.push(current);
      const { title, message, pages } = fixture.legacy;
      assert.equal(pages.length, 1);
      const legacyResult = await dialog.showMessageBox(parent, {
        type: 'warning',
        title,
        message: `Request 1\n${message}`,
        detail: pages[0],
        buttons: ['Cancel', 'Approve & sign'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      assert.equal(legacyResult.response, 0, 'Enter cancels even an overflowing legacy dialog');
      if (process.env.CONFIRMATION_BASELINE_ONLY === '1') continue;
      current = { name: fixture.name, version: 'new', pages: [] };
      results.push(current);
      assert.equal(await confirmSignature(parent, fixture.request, fixture.context), true);
    }
    save();
    console.log(
      JSON.stringify({
        profile: path.basename(profile),
        legacyOverflows: results
          .filter((r) => r.version === 'legacy' && r.pages.some((p) => !p.fits))
          .map((r) => r.name),
        newPages: results
          .filter((r) => r.version === 'new')
          .reduce((sum, r) => sum + r.pages.length, 0),
        maxHeight: Math.max(
          ...results
            .filter((r) => r.version === 'new')
            .flatMap((r) => r.pages.map((p) => p.box.height)),
        ),
        maxWidth: Math.max(
          ...results
            .filter((r) => r.version === 'new')
            .flatMap((r) => r.pages.map((p) => p.box.width)),
        ),
        detailRows: [
          ...new Set(results.flatMap((r) => r.pages.flatMap((p) => p.detailRowHeights))),
        ],
        headingRows: [
          ...new Set(results.flatMap((r) => r.pages.flatMap((p) => p.headingRowHeights))),
        ],
        chrome: [...new Set(results.flatMap((r) => r.pages.map((p) => p.chromeHeight)))],
      }),
    );
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
