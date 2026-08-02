const imageModules = import.meta.glob<string>('../../images/*.{jpg,jpeg,png,webp,JPG,JPEG,PNG,WEBP}', {
  eager: true,
  import: 'default',
  query: '?url',
});

const imagePaths = Object.keys(imageModules).sort();

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

  it('records the expected markings for general-purpose_4ft_frontal.webp', () => {
    expect(expectedMarkingsByFile['general-purpose_4ft_frontal.webp']).toEqual({
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
    });
  });

  it('records the expected markings for general-purpose_4ft_front-left-oblique.webp', () => {
    expect(expectedMarkingsByFile['general-purpose_4ft_front-left-oblique.webp']).toEqual({
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
    });
  });
});
