import { expect, test, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';

type ExpectedMarkings = {
  containerId: string;
  isoCode?: string;
  mpgmKg: string;
  tareKg: string;
  mpgmLb?: string;
  tareLb?: string;
  payloadKg?: string;
  payloadLb?: string;
  calculatedPayloadKg?: string;
  calculatedPayloadLb?: string;
  capacityCubicMeters?: string;
  capacityCubicFeet?: string;
};

const expectedMarkingsByFile: Record<string, ExpectedMarkings> = {
  'iso-tank_frontal.jpg': {
    containerId: 'LASU2100400',
    isoCode: '22K2',
    mpgmKg: '36000',
    mpgmLb: '79365',
    tareKg: '3650',
    tareLb: '8047',
  },
  'iso-tank_front-right-oblique.jpg': {
    containerId: 'MEBU1263476',
    isoCode: '22K2',
    mpgmKg: '34.000',
    tareKg: '3.650',
    payloadKg: '30350',
    calculatedPayloadKg: '30.350',
  },
  'general-purpose_4ft_frontal.webp': {
    containerId: 'SDNU9204594',
    mpgmKg: '3.000',
    mpgmLb: '6.610',
    tareKg: '560',
    tareLb: '1.230',
    payloadKg: '2.440',
    payloadLb: '5.380',
    calculatedPayloadKg: '2.440',
    calculatedPayloadLb: '5.380',
    capacityCubicMeters: '4.6',
    capacityCubicFeet: '162',
  },
  'general-purpose_4ft_front-left-oblique.webp': {
    containerId: 'HCSU7997909',
    mpgmKg: '3.000',
    mpgmLb: '6.610',
    tareKg: '670',
    tareLb: '1.477',
    payloadKg: '2.330',
    payloadLb: '5.133',
    calculatedPayloadKg: '2.330',
    calculatedPayloadLb: '5.133',
    capacityCubicMeters: '4.6',
    capacityCubicFeet: '162',
  },
};

function fieldLocator(page: Page, field: keyof ExpectedMarkings): Locator {
  const kilogramRow = page.locator('.weight-row').nth(0);
  const poundRow = page.locator('.weight-row').nth(1);
  const capacityRow = page.locator('.capacity-row');
  switch (field) {
    case 'containerId': return page.locator('.container-id-field input');
    case 'isoCode': return page.locator('.field-grid > label:not(.container-id-field) input');
    case 'mpgmKg': return kilogramRow.locator('label').nth(0).locator('input');
    case 'tareKg': return kilogramRow.locator('label').nth(1).locator('input');
    case 'payloadKg': return kilogramRow.locator('label').nth(2).locator('input');
    case 'calculatedPayloadKg': return kilogramRow.locator('label').nth(2).locator('output');
    case 'mpgmLb': return poundRow.locator('label').nth(0).locator('input');
    case 'tareLb': return poundRow.locator('label').nth(1).locator('input');
    case 'payloadLb': return poundRow.locator('label').nth(2).locator('input');
    case 'calculatedPayloadLb': return poundRow.locator('label').nth(2).locator('output');
    case 'capacityCubicMeters': return capacityRow.locator('label').nth(1).locator('input');
    case 'capacityCubicFeet': return capacityRow.locator('label').nth(2).locator('input');
  }
}

for (const [fileName, expectedMarkings] of Object.entries(expectedMarkingsByFile)) {
  test(`extracts expected markings from ${fileName}`, async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(join(process.cwd(), 'images', fileName));

    await expect.poll(
      () => fieldLocator(page, 'containerId').inputValue(),
      { timeout: 90_000 },
    ).toBe(expectedMarkings.containerId);

    for (const [field, expected] of Object.entries(expectedMarkings) as Array<[keyof ExpectedMarkings, string]>) {
      const locator = fieldLocator(page, field);
      if (field.startsWith('calculated')) {
        await expect(locator).toHaveText(expected);
      } else {
        await expect(locator).toHaveValue(expected);
      }
    }
  });
}
