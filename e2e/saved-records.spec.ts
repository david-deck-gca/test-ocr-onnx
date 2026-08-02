import { expect, test } from '@playwright/test';
import { join } from 'node:path';

test('saves a photo and JSON payload, lists it, and deletes it', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('container-mark-reader');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The saved-record database is still open.'));
  }));
  await page.reload();

  await page.locator('input[type="file"]').setInputFiles(join(process.cwd(), 'images', 'iso-tank_frontal.jpg'));
  const saveButton = page.getByRole('button', { name: 'Save photo & data' });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();

  await expect(page.locator('.saved-records li')).toHaveCount(1);
  await expect(page.locator('.saved-records img')).toHaveCount(1);
  const storedRecords = await page.evaluate(() => new Promise<Array<{ fileName: string; hasPayload: boolean; photoSize: number }>>((resolve, reject) => {
    const request = indexedDB.open('container-mark-reader');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const recordsRequest = database.transaction('records', 'readonly').objectStore('records').getAll();
      recordsRequest.onerror = () => reject(recordsRequest.error);
      recordsRequest.onsuccess = () => {
        resolve(recordsRequest.result.map((record) => ({
          fileName: record.fileName,
          hasPayload: Boolean(record.payload),
          photoSize: record.photo.size,
        })));
        database.close();
      };
    };
  }));

  expect(storedRecords).toEqual([{ fileName: 'iso-tank_frontal.jpg', hasPayload: true, photoSize: expect.any(Number) }]);
  expect(storedRecords[0].photoSize).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.saved-records li')).toHaveCount(0);
});
