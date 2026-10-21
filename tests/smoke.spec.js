// smoke.spec.js — Unzip Files Online: the core actions on bundled, fictional fixtures (see fixtures/make-fixtures.js).
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const fflate = require('../vendor/fflate/fflate.js');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

// Simulates a real drag-and-drop of a fixture onto the drop zone.
async function dropFile(page, name, as = name) {
  const b64 = fs.readFileSync(fixture(name)).toString('base64');
  await page.evaluate(({ b64, as }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], as, { type: as.endsWith('.zip') ? 'application/zip' : '' }));
    const zone = document.getElementById('dropzone');
    for (const type of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { b64, as });
}

const row = (page, name) => page.locator('#entries-body tr.entry').filter({ has: page.locator('.entry__label', { hasText: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}$`) }) });

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

test.describe('Unzip Files Online', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
    await page.waitForFunction(() => window.fflate && window.__demo);
  });

  test('dropping sample-archive.zip lists its files with sizes and folder structure', async ({ page }) => {
    const errors = watchErrors(page);
    await dropFile(page, 'sample-archive.zip');
    await expect(page.locator('#explorer')).toBeVisible();
    await expect(page.locator('#archive-name')).toHaveText('sample-archive.zip');
    await expect(page.locator('[data-stat="files"]')).toHaveText('5 files');
    await expect(page.locator('[data-stat="ratio"]')).toContainText('%');
    // folders, files, the empty folder and sizes
    for (const dir of ['data', 'empty-folder', 'images', 'nested', 'notes']) await expect(row(page, dir)).toHaveClass(/entry--dir/);
    await expect(row(page, 'empty-folder')).toContainText('Empty folder');
    await expect(row(page, 'readme.txt').locator('.c-size')).toHaveText('93 B');
    await expect(row(page, 'small.png').locator('.c-size')).toHaveText('5.9 KB');
    await expect(row(page, 'todo.md')).toHaveAttribute('aria-level', '2');
    // collapsing a folder hides its children, expanding shows them again
    await row(page, 'notes').locator('.entry__open').click();
    await expect(row(page, 'todo.md')).toHaveCount(0);
    await row(page, 'notes').locator('.entry__open').click();
    await expect(row(page, 'todo.md')).toHaveCount(1);
    // the name filter
    await page.fill('#filter', 'inventory');
    await expect(page.locator('#entries-body tr.entry')).toHaveCount(2); // data/ + inventory.csv
    await page.fill('#filter', '');
    expect(errors).toEqual([]);
  });

  test('clicking a text file entry shows a preview of its first lines', async ({ page }) => {
    await page.setInputFiles('#file-input', fixture('sample-archive.zip'));
    await row(page, 'readme.txt').locator('.entry__open').click();
    await expect(page.locator('#preview-title')).toHaveText('readme.txt');
    await expect(page.locator('#preview pre')).toContainText('Sample archive readme');
    await expect(page.locator('#preview pre')).toContainText('Line three of the readme.');
    // deflated file in a subfolder, and an image preview
    await row(page, 'todo.md').locator('.entry__open').click();
    await expect(page.locator('#preview pre')).toContainText('Water the plants');
    await row(page, 'small.png').locator('.entry__open').click();
    const img = page.locator('#preview img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  });

  test('clicking Save on one entry downloads that file with its original name', async ({ page }) => {
    await page.setInputFiles('#file-input', fixture('sample-archive.zip'));
    const [download] = await Promise.all([page.waitForEvent('download'), row(page, 'todo.md').locator('.entry__save').click()]);
    expect(download.suggestedFilename()).toBe('todo.md');
    const text = fs.readFileSync(await download.path(), 'utf8');
    expect(text).toContain('Return the library books');
    // a binary entry keeps its exact bytes
    const [png] = await Promise.all([page.waitForEvent('download'), row(page, 'small.png').locator('.entry__save').click()]);
    expect(png.suggestedFilename()).toBe('small.png');
    expect(fs.readFileSync(await png.path()).equals(fs.readFileSync(fixture('small.png')))).toBeTruthy();
  });

  test('the Save all button downloads each file without errors', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setInputFiles('#file-input', fixture('sample-archive.zip'));
    await expect(page.locator('#save-all')).toHaveText('Save all 5 as separate files');
    const downloads = [];
    page.on('download', (d) => downloads.push(d));
    await page.click('#save-all');
    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(5);
    const names = downloads.map((d) => d.suggestedFilename()).sort();
    expect(names).toEqual(['inner.zip', 'inventory.csv', 'readme.txt', 'small.png', 'todo.md']);
    for (const d of downloads) expect(fs.statSync(await d.path()).size).toBeGreaterThan(0);
    await expect(page.locator('#results .alert--error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('selected files can be saved separately or repacked into a new ZIP', async ({ page }) => {
    await page.setInputFiles('#file-input', fixture('holiday-photos-notes.zip'));
    await expect(page.locator('#save-selected')).toBeDisabled();
    await row(page, 'Receipts').locator('.entry__check').check();
    await row(page, 'readme.txt').locator('.entry__check').check();
    await expect(page.locator('#selection-info')).toContainText('3 of 5 files selected');
    const [zip] = await Promise.all([page.waitForEvent('download'), page.click('#zip-selected')]);
    expect(zip.suggestedFilename()).toBe('holiday-photos-notes-selected.zip');
    const files = fflate.unzipSync(new Uint8Array(fs.readFileSync(await zip.path())));
    expect(Object.keys(files).sort()).toEqual(['Receipts/café-breakfast.txt', 'Receipts/ferry-ticket.txt', 'readme.txt']);
    expect(fflate.strFromU8(files['readme.txt'])).toContain('Lakeside cabin trip');
    const downloads = [];
    page.on('download', (d) => downloads.push(d));
    await page.click('#save-selected');
    await expect.poll(() => downloads.length, { timeout: 10_000 }).toBe(3);
    expect(downloads.map((d) => d.suggestedFilename()).sort()).toEqual(['café-breakfast.txt', 'ferry-ticket.txt', 'readme.txt']);
  });

  test('a corrupt file shows a clear error message', async ({ page }) => {
    await page.setInputFiles('#file-input', fixture('corrupt.zip'));
    const err = page.locator('#results .alert--error');
    await expect(err).toHaveCount(1);
    await expect(err).toHaveAttribute('data-kind', 'corrupt');
    await expect(err).toContainText('Corrupt archive');
    await expect(err).toContainText('damaged or incomplete');
    await expect(page.locator('#explorer')).toBeHidden();
    // a file that is not a ZIP at all gets a different message
    await page.setInputFiles('#file-input', fixture('sample.txt'));
    await expect(err).toHaveAttribute('data-kind', 'not-zip');
    await expect(err).toContainText('Not a ZIP file');
    // a PNG renamed .zip is recognised for what it is
    await page.setInputFiles('#file-input', { name: 'photo.zip', mimeType: 'application/zip', buffer: fs.readFileSync(fixture('small.png')) });
    await expect(err).toContainText('PNG image, not a ZIP');
    // a Windows executable (self-extracting archive) is rejected
    await page.setInputFiles('#file-input', { name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]) });
    await expect(err).toHaveAttribute('data-kind', 'sfx');
    // split archives are explained
    await page.setInputFiles('#file-input', { name: 'backup.z01', mimeType: '', buffer: Buffer.alloc(100) });
    await expect(err).toHaveAttribute('data-kind', 'multipart');
  });

  test('dropping a non-ZIP together with a ZIP opens the ZIP and names the skipped file', async ({ page }) => {
    const a = fs.readFileSync(fixture('sample.txt')).toString('base64');
    const b = fs.readFileSync(fixture('sample-archive.zip')).toString('base64');
    await page.evaluate(({ a, b }) => {
      const mk = (s, n, t) => new File([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], n, { type: t });
      const dt = new DataTransfer();
      dt.items.add(mk(a, 'notes.txt', 'text/plain'));
      dt.items.add(mk(b, 'sample-archive.zip', 'application/zip'));
      document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { a, b });
    await expect(page.locator('#archive-name')).toHaveText('sample-archive.zip');
    await expect(page.locator('#results .alert--error')).toContainText('"notes.txt" was skipped because it is not a ZIP archive');
  });

  test('edge cases: encrypted, unsupported method, unsafe paths, duplicates and old Windows names', async ({ page }) => {
    await page.setInputFiles('#file-input', fixture('edge-cases.zip'));
    await expect(row(page, 'secret.txt')).toContainText('Password protected');
    await expect(row(page, 'secret.txt').locator('.entry__save')).toBeDisabled();
    await expect(page.locator('#results')).toContainText('cannot open password-protected files');
    await row(page, 'secret.txt').locator('.entry__open').click();
    await expect(page.locator('#preview')).toContainText('cannot open encrypted files');
    await expect(row(page, 'old-method.bin')).toContainText('Unsupported compression');
    await expect(page.locator('#results')).toContainText('bzip2');
    await expect(page.locator('#results')).toContainText('Unsafe paths cleaned');
    await expect(row(page, 'outside.txt')).toHaveAttribute('aria-level', '1');
    await expect(row(page, 'dup.txt')).toHaveCount(1);
    await expect(row(page, 'dup (2).txt')).toHaveCount(1);
    await expect(row(page, 'Résumé.txt')).toHaveCount(1); // CP437 bytes decoded
    const [dl] = await Promise.all([page.waitForEvent('download'), row(page, 'outside.txt').locator('.entry__save').click()]);
    expect(dl.suggestedFilename()).toBe('outside.txt');
    // two different folders with the same file name: saving both numbers the second
    await row(page, 'a').locator('.entry__check').check();
    await row(page, 'b').locator('.entry__check').check();
    const downloads = [];
    page.on('download', (d) => downloads.push(d));
    await page.click('#save-selected');
    await expect.poll(() => downloads.length).toBe(2);
    expect(downloads.map((d) => d.suggestedFilename()).sort()).toEqual(['same (2).txt', 'same.txt']);
  });

  test('a nested ZIP can be opened and you can go back', async ({ page }) => {
    await page.setInputFiles('#file-input', fixture('sample-archive.zip'));
    await row(page, 'inner.zip').locator('.entry__open').click();
    await page.click('#open-nested');
    await expect(page.locator('#archive-name')).toHaveText('inner.zip');
    await expect(row(page, 'hello.txt')).toHaveCount(1);
    await page.click('#back-parent');
    await expect(page.locator('#archive-name')).toHaveText('sample-archive.zip');
  });

  test('keyboard: arrows move, space selects, Enter previews', async ({ page }) => {
    await page.setInputFiles('#file-input', fixture('holiday-photos-notes.zip'));
    const first = page.locator('#entries-body tr.entry').first();
    await first.focus();
    // rows: Receipts, café-breakfast.txt, ferry-ticket.txt, lake-view.png, packing-list.csv, readme.txt
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'ferry-ticket.txt')).toBeFocused();
    await page.keyboard.press(' ');
    await expect(row(page, 'ferry-ticket.txt').locator('.entry__check')).toBeChecked();
    await page.keyboard.press('Enter');
    await expect(page.locator('#preview pre')).toContainText('Island ferry');
    await page.keyboard.press('End');
    await expect(row(page, 'readme.txt')).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowLeft'); // collapse Receipts
    await expect(row(page, 'ferry-ticket.txt')).toHaveCount(0);
  });

  test('works at 390px wide', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('./');
    await page.waitForFunction(() => window.fflate);
    await expect(page.locator('#dropzone')).toBeInViewport();
    await page.setInputFiles('#file-input', fixture('holiday-photos-notes.zip'));
    await expect(row(page, 'café-breakfast.txt')).toBeVisible();
    await row(page, 'readme.txt').locator('.entry__open').click();
    await expect(page.locator('#preview pre')).toContainText('Lakeside cabin trip');
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, wrap: document.querySelector('.table-wrap').scrollWidth - document.querySelector('.table-wrap').clientWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.win + 1);
    expect(widths.wrap).toBeLessThanOrEqual(1);
    const save = row(page, 'packing-list.csv').locator('.entry__save');
    await expect(save).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), save.click()]);
    expect(dl.suggestedFilename()).toBe('packing-list.csv');
    await expect(page.locator('#save-all')).toBeVisible();
  });

  test('a large entry is inflated in the worker with a correct checksum', async ({ page }) => {
    const big = new Uint8Array(6 * 1024 * 1024).map((_, i) => 65 + ((i * 7) % 26));
    const zip = Buffer.from(fflate.zipSync({ 'big/letters.txt': [big, { level: 6 }] }));
    await page.setInputFiles('#file-input', { name: 'big.zip', mimeType: 'application/zip', buffer: zip });
    await expect(row(page, 'letters.txt').locator('.c-size')).toHaveText('6.0 MB');
    const [dl] = await Promise.all([page.waitForEvent('download'), row(page, 'letters.txt').locator('.entry__save').click()]);
    const bytes = fs.readFileSync(await dl.path());
    expect(bytes.length).toBe(big.length);
    expect(bytes.equals(Buffer.from(big))).toBeTruthy();
  });

  test('__demo shows the holiday archive with a preview', async ({ page }) => {
    const errors = watchErrors(page);
    await page.evaluate(() => window.__demo());
    await expect(page.locator('#archive-name')).toHaveText('holiday-photos-notes.zip');
    await expect(page.locator('#preview pre')).toContainText('Pinecrest Lake');
    await expect(page.locator('#selection-info')).toContainText('2 of 5 files selected');
    expect(errors).toEqual([]);
  });
});
