import { expect, test } from '@playwright/test';
import path from 'node:path';

test.describe('real OCR regressions', () => {
  test('extracts the frontal ISO tank markings', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(path.resolve('images/iso-tank_frontal.jpg'));

    const status = page.locator('.status');
    await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });
    await expect(page.locator('.diagnostics')).toHaveCount(0);

    const expectedFields = [
      ['Container ID', 'LASU 210040 0', null],
      ['ISO CODE', '22K2', ''],
      ['MPGM', '36000', 'KG'],
      ['MPGM LB', '79365', 'LB'],
      ['TARE', '3650', 'KG'],
      ['TARE LB', '8047', 'LB'],
    ] as const;

    for (const [label, value, unit] of expectedFields) {
      const row = label.endsWith(' LB')
        ? page.locator('tr').filter({ has: page.locator(`input[aria-label="${label}"]`) })
        : page.locator('tr').filter({
          has: page.getByRole('rowheader', { name: label, exact: true }),
        });

      await expect(row).toHaveCount(1);
      await expect(row.locator('input')).toHaveValue(value);
      if (unit !== null) {
        await expect(row.locator('.unit')).toHaveText(unit);
      }
    }
  });

  test('extracts the front-right oblique ISO tank markings', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(path.resolve('images/iso-tank_front-right-oblique.jpg'));

    const status = page.locator('.status');
    await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });
    await expect(page.locator('.diagnostics')).toHaveCount(0);

    const expectedFields = [
      ['Container ID', 'MEBU 126347 6', null],
      ['ISO CODE', '22K2', ''],
      ['MGW', '34.000', 'KG'],
      ['TARE', '3.650', 'KG'],
      ['PAYLOAD', '30.350', 'KG'],
      ['CAPACITY', '25.000', 'L'],
    ] as const;

    for (const [label, value, unit] of expectedFields) {
      const row = page.locator('tr').filter({
        has: page.getByRole('rowheader', { name: label, exact: true }),
      });

      await expect(row).toHaveCount(1);
      await expect(row.locator('input')).toHaveValue(value);
      if (unit !== null) {
        await expect(row.locator('.unit')).toHaveText(unit);
      }
    }
  });

  test('extracts the frontal 4ft general-purpose container markings', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(path.resolve('images/general-purpose_4ft_frontal.webp'));

    const status = page.locator('.status');
    await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });
    await expect(page.locator('.diagnostics')).toHaveCount(0);

    const expectedFields = [
      ['Container ID', 'SDNU 920459 4', null],
      ['MAX.GR.', '3.000', 'KG'],
      ['MAX.GR. LB', '6.610', 'LB'],
      ['TARE', '560', 'KG'],
      ['TARE LB', '1.230', 'LB'],
      ['NET', '2.440', 'KG'],
      ['NET LB', '5.380', 'LB'],
      ['CU.CAP.', '4.6', 'CU.M.'],
      ['CU.CAP. CU.FT.', '162', 'CU.FT.'],
    ] as const;

    for (const [label, value, unit] of expectedFields) {
      const row = label.includes(' LB') || label.endsWith('CU.FT.')
        ? page.locator('tr').filter({ has: page.locator(`input[aria-label="${label}"]`) })
        : page.locator('tr').filter({
          has: page.getByRole('rowheader', { name: label, exact: true }),
        });

      await expect(row).toHaveCount(1);
      await expect(row.locator('input')).toHaveValue(value);
      if (unit !== null) {
        await expect(row.locator('.unit')).toHaveText(unit);
      }
    }
  });

  test('extracts the front-left oblique 4ft general-purpose container markings', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(path.resolve('images/general-purpose_4ft_front-left-oblique.webp'));

    const status = page.locator('.status');
    await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });
    await expect(page.locator('.diagnostics')).toHaveCount(0);

    const expectedFields = [
      ['Container ID', 'HCSU 799790 9', null],
      ['MAX.GR.', '3.000', 'KG'],
      ['MAX.GR. LB', '6.610', 'LB'],
      ['TARE', '670', 'KG'],
      ['TARE LB', '1.477', 'LB'],
      ['NET', '2.330', 'KG'],
      ['NET LB', '5,133', 'LB'],
      ['CU.CAP.', '4.60', 'CU.M.'],
      ['CU.CAP. CU.FT.', '161', 'CU.FT.'],
    ] as const;

    for (const [label, value, unit] of expectedFields) {
      const row = label.includes(' LB') || label.endsWith('CU.FT.')
        ? page.locator('tr').filter({ has: page.locator(`input[aria-label="${label}"]`) })
        : page.locator('tr').filter({
          has: page.getByRole('rowheader', { name: label, exact: true }),
        });

      await expect(row).toHaveCount(1);
      await expect(row.locator('input')).toHaveValue(value);
      if (unit !== null) {
        await expect(row.locator('.unit')).toContainText(unit);
      }
    }
  });

  test('extracts the frontal 20ft general-purpose container markings', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(path.resolve('images/general-purpose_20ft_frontal.jpg'));

    const status = page.locator('.status');
    await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });
    await expect(page.locator('.diagnostics')).toHaveCount(0);

    const expectedFields = [
      ['Container ID', 'AGZU 111135 5', null],
      ['ISO CODE', '22G1', ''],
      ['MAX.GR.', '30.480', 'KG'],
      ['MAX.GR. LB', '67.200', 'LB'],
      ['TARE', '2.100', 'KG'],
      ['TARE LB', '4.630', 'LB'],
      ['PAYLOAD', '28.380', 'KG'],
      ['PAYLOAD LB', '62.570', 'LB'],
      ['CU.CAP.', '33.2', 'CU.M.'],
      ['CU.CAP. CU.FT.', '1.172', 'CU.FT.'],
    ] as const;

    for (const [label, value, unit] of expectedFields) {
      const row = label.includes(' LB') || label.endsWith('CU.FT.')
        ? page.locator('tr').filter({ has: page.locator(`input[aria-label="${label}"]`) })
        : page.locator('tr').filter({
          has: page.getByRole('rowheader', { name: label, exact: true }),
        });

      await expect(row).toHaveCount(1);
      await expect(row.locator('input')).toHaveValue(value);
      if (unit !== null) {
        await expect(row.locator('.unit')).toContainText(unit);
      }
    }
  });

  test('extracts the UN tank 3 markings', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(path.resolve('images/un-tank_3.JPG'));

    const status = page.locator('.status');
    await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });
    await expect(page.locator('.diagnostics')).toHaveCount(0);

    const expectedFields = [
      ['MAX WORKING PRESSURE', '10', 'BAR'],
      ['Container ID', 'EUXU 700755 3', null],
      ['APPROVAL CODE', '58K2', null],
      ['APPLICABLE REGULATIONS', 'RID-ADR-IMDG', null],
      ['TANK CODE', 'T22', null],
      ['MAX.GR.', '4300', 'KG'],
      ['MAX.GR. LB', '9480', 'LB'],
      ['TARE', '772', 'KG'],
      ['TARE LB', '1701', 'LB'],
      ['CAPACITY', '1108', 'L'],
      ['CAPACITY US GAL', '293', 'US GAL'],
      ['KEMLER CODE', '368', null],
      ['UN NUMBER', '3286', null],
    ] as const;

    for (const [label, value, unit] of expectedFields) {
      const row = label.endsWith(' LB') || label.endsWith('US GAL')
        ? page.locator('tr').filter({ has: page.locator(`input[aria-label="${label}"]`) })
        : page.locator('tr').filter({
          has: page.getByRole('rowheader', { name: label, exact: true }),
        });

      await expect(row).toHaveCount(1);
      await expect(row.locator('input')).toHaveValue(value);
      if (unit !== null) {
        await expect(row.locator('.unit')).toContainText(unit);
      }
    }
  });

  test('extracts the UN tank 2 markings', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(path.resolve('images/un-tank_2.JPG'));

    const status = page.locator('.status');
    await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });
    await expect(page.locator('.diagnostics')).toHaveCount(0);

    const expectedFields = [
      ['MAX WORKING PRESSURE', '10', 'BAR'],
      ['Container ID', 'EUXU 700686 0', null],
      ['APPROVAL CODE', '58K2', null],
      ['APPLICABLE REGULATIONS', 'RID-ADR-IMDG', null],
      ['TANK CODE', 'T22', null],
      ['MAX.GR.', '4300', 'KG'],
      ['MAX.GR. LB', '9480', 'LB'],
      ['TARE', '784', 'KG'],
      ['TARE LB', '1728', 'LB'],
      ['CAPACITY', '1101', 'L'],
      ['CAPACITY US GAL', '291', 'US GAL'],
      ['KEMLER CODE', '368', null],
      ['UN NUMBER', '3286', null],
    ] as const;

    for (const [label, value, unit] of expectedFields) {
      const row = label.endsWith(' LB') || label.endsWith('US GAL')
        ? page.locator('tr').filter({ has: page.locator(`input[aria-label="${label}"]`) })
        : page.locator('tr').filter({
          has: page.getByRole('rowheader', { name: label, exact: true }),
        });

      await expect(row).toHaveCount(1);
      await expect(row.locator('input')).toHaveValue(value);
      if (unit !== null) {
        await expect(row.locator('.unit')).toContainText(unit);
      }
    }
  });
});
