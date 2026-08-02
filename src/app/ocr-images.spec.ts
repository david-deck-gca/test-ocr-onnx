const imageModules = import.meta.glob<string>('../../images/*.{jpg,jpeg,png,webp,JPG,JPEG,PNG,WEBP}', {
  eager: true,
  import: 'default',
  query: '?url',
});

const imagePaths = Object.keys(imageModules).sort();

type ExpectedMarkings = {
  containerId: string;
  isoCode: string;
  mpgmKg: string;
  tareKg: string;
  mpgmLb?: string;
  tareLb?: string;
  payloadKg?: string;
  calculatedPayloadKg?: string;
};

const expectedMarkingsByFile: Partial<Record<string, ExpectedMarkings>> = {
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
};

describe('OCR reference images', () => {
  it('discovers at least one image', () => {
    expect(imagePaths.length).toBeGreaterThan(0);
  });

  it.each(imagePaths)('%s is available for OCR expectations', (imagePath) => {
    expect(imageModules[imagePath]).toEqual(expect.any(String));
  });

  it('records the expected markings for iso-tank_frontal.jpg', () => {
    expect(expectedMarkingsByFile['iso-tank_frontal.jpg']).toEqual({
      containerId: 'LASU2100400',
      isoCode: '22K2',
      mpgmKg: '36000',
      mpgmLb: '79365',
      tareKg: '3650',
      tareLb: '8047',
    });
  });

  it('records the expected markings for iso-tank_front-right-oblique.jpg', () => {
    expect(expectedMarkingsByFile['iso-tank_front-right-oblique.jpg']).toEqual({
      containerId: 'MEBU1263476',
      isoCode: '22K2',
      mpgmKg: '34.000',
      tareKg: '3.650',
      payloadKg: '30350',
      calculatedPayloadKg: '30.350',
    });
  });
});
