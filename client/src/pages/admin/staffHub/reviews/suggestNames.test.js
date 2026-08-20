import { suggestNames } from './suggestNames';

const staff = [
  { id: 7, display_name: 'Shea Corrigan' },
  { id: 8, preferred_name: 'Marcus Webb' },
  { id: 9, display_name: 'Al (Bar) Smith' },      // regex metacharacters in a user-editable name
  { id: 10, email: 'nobody@example.com' },         // no name at all
];

test('whole-word, case-insensitive first-name match', () => {
  expect(suggestNames('It was wonderful! shea was so prompt.', staff)).toEqual(['7']);
  expect(suggestNames('Marcus kept the line moving and Shea built the menu', staff)).toEqual(['7', '8']);
});

test('no partial-word matches; empty excerpt suggests nobody; names with metacharacters never throw', () => {
  expect(suggestNames('Sheamus was great', staff)).toEqual([]);
  expect(suggestNames('', staff)).toEqual([]);
  expect(() => suggestNames('Al was here', staff)).not.toThrow();
  expect(suggestNames('Al was here', staff)).toEqual(['9']);
});
