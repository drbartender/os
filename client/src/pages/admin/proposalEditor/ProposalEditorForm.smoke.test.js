// Import-smoke only: forces module resolution + parse of the full editor
// graph while it is not yet mounted anywhere. Catches wrong ../ depths that
// the CI build cannot see pre-mount. No rendering.
jest.mock('../../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() },
}));

it('editor module graph resolves', () => {
  expect(require('./ProposalEditorForm').default).toEqual(expect.any(Function));
  expect(require('./PackageSection').default).toEqual(expect.any(Function));
  expect(require('./RepriceConfirmModal').default).toEqual(expect.any(Function));
});
