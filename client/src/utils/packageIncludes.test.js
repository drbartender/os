import { interpolatePackageIncludes } from './packageIncludes';

test('interpolates bartenders, plural suffix, and hours', () => {
  expect(interpolatePackageIncludes(
    ['{bartenders} professional bartender{bartenders_s}', '{hours} hours of service'],
    { bartenders: 2, durationHours: 4 }
  )).toEqual(['2 professional bartenders', '4 hours of service']);
});

test('singular drops the s', () => {
  expect(interpolatePackageIncludes(['{bartenders} bartender{bartenders_s}'], { bartenders: 1 }))
    .toEqual(['1 bartender']);
});

test('null ctx values leave tokens untouched, null items give empty list', () => {
  expect(interpolatePackageIncludes(['{hours} hours'], {})).toEqual(['{hours} hours']);
  expect(interpolatePackageIncludes(['plain line'], undefined)).toEqual(['plain line']);
  expect(interpolatePackageIncludes(null, { bartenders: 2 })).toEqual([]);
});
