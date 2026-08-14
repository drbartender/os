import { canInstall, onInstallAvailability, promptInstall } from './installPrompt';

function fireBeforeInstallPrompt() {
  const e = new Event('beforeinstallprompt');
  e.prompt = jest.fn();
  e.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(e);
  return e;
}

test('captures the event, notifies subscribers, prompts once', async () => {
  expect(canInstall()).toBe(false);
  const seen = [];
  onInstallAvailability((v) => seen.push(v));
  const e = fireBeforeInstallPrompt();
  expect(canInstall()).toBe(true);
  expect(seen).toEqual([true]);
  const choice = await promptInstall();
  expect(e.prompt).toHaveBeenCalledTimes(1);
  expect(choice.outcome).toBe('accepted');
  expect(canInstall()).toBe(false);
  expect(await promptInstall()).toEqual({ outcome: 'unavailable' });
});
