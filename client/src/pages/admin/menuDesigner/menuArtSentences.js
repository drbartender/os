// Client mirror of SENTENCES, FIXED_TEXTS and BRIEF_FIX_TEXTS in
// server/utils/menuArtJobErrors.js: every fixed text the menu art job can store
// as a words_error or a piece's error, the only stored error text the Bar menu
// card and the editor show (spec 2026-10-19 section 16, lane
// menu-error-display).
//
// Keep both equal to the server's, keys and order included;
// server/utils/menuArtSentences.test.js imports this file and pins them.
// isFixedSentence(text) is true for one of FIXED_TEXTS exactly and for nothing
// else, so a provider's own message, "interrupted" or any other stored text
// reads as the generic line instead. SENTENCES names the ones the card reads
// by key (the run-stopping piece sentences).
export const SENTENCES = Object.freeze({
  noDrinks: 'The drink plan has no drinks to put on the menu.',
  wordsBusy: 'OpenAI is busy right now. Try again in a minute.',
  wordsOutOfCredit: "OpenAI is out of credit. Add credit in OpenAI's billing settings, then Generate again.",
  wordsLimit: "OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then Generate again.",
  syncWordsOutOfCredit: "OpenAI is out of credit. Add credit in OpenAI's billing settings, then try Update draft again.",
  syncWordsLimit: "OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then try Update draft again.",
  anthropicWordsOutOfCredit: "Anthropic is out of credit. Add credit in Anthropic's billing settings, then Generate again.",
  anthropicSyncWordsOutOfCredit: "Anthropic is out of credit. Add credit in Anthropic's billing settings, then try Update draft again.",
  anthropicWordsLimit: "Anthropic hit a spend limit. Raise it in Anthropic's limits settings, then Generate again.",
  anthropicSyncWordsLimit: "Anthropic hit a spend limit. Raise it in Anthropic's limits settings, then try Update draft again.",
  openaiOutOfCredit: "OpenAI is out of credit. Add credit in OpenAI's billing settings, then re-roll.",
  openaiLimit: "OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then re-roll.",
  geminiStillRefusing: "Gemini is still refusing. If this keeps happening, check Gemini's billing.",
  wordsProvider: 'OpenAI could not write the menu words. Try again.',
  wordsFailed: 'The menu words could not be written. Try again.',
  notSetUp: 'Menu art is not set up.',
  referenceUnavailable: 'The reference image is unavailable. Start over without it or upload it again.',
  referenceUnreadable: 'The reference image could not be read. Start over with a different one.',
  backgroundUnavailable: 'The background image could not be read. Re-roll this drink in a moment.',
  noProvider: 'This piece has no image model. Re-roll it.',
  geminiOff: 'Gemini is not set up.',
  notReserved: 'This piece was not reserved. Re-roll it.',
  unprocessable: 'The drawn image could not be processed. Re-roll it.',
  saveFailed: 'The drawn image could not be saved. Re-roll it.',
  drawFailed: 'Something went wrong drawing this image. Re-roll it.',
});

export const FIXED_TEXTS = Object.freeze([
  'The drink plan has no drinks to put on the menu.',
  'OpenAI is busy right now. Try again in a minute.',
  "OpenAI is out of credit. Add credit in OpenAI's billing settings, then Generate again.",
  "OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then Generate again.",
  "OpenAI is out of credit. Add credit in OpenAI's billing settings, then try Update draft again.",
  "OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then try Update draft again.",
  "Anthropic is out of credit. Add credit in Anthropic's billing settings, then Generate again.",
  "Anthropic is out of credit. Add credit in Anthropic's billing settings, then try Update draft again.",
  "Anthropic hit a spend limit. Raise it in Anthropic's limits settings, then Generate again.",
  "Anthropic hit a spend limit. Raise it in Anthropic's limits settings, then try Update draft again.",
  "OpenAI is out of credit. Add credit in OpenAI's billing settings, then re-roll.",
  "OpenAI hit a spend or usage limit. Raise it in OpenAI's limits settings, then re-roll.",
  "Gemini is still refusing. If this keeps happening, check Gemini's billing.",
  'OpenAI could not write the menu words. Try again.',
  'The menu words could not be written. Try again.',
  'Menu art is not set up.',
  'The reference image is unavailable. Start over without it or upload it again.',
  'The reference image could not be read. Start over with a different one.',
  'The background image could not be read. Re-roll this drink in a moment.',
  'This piece has no image model. Re-roll it.',
  'Gemini is not set up.',
  'This piece was not reserved. Re-roll it.',
  'The drawn image could not be processed. Re-roll it.',
  'The drawn image could not be saved. Re-roll it.',
  'Something went wrong drawing this image. Re-roll it.',
  'OpenAI declined to write this menu. Try different art direction.',
  'Anthropic declined to write this menu. Try a different brief.',
  'The menu words came back in the wrong shape. Try again.',
  'The menu words left out a drink. Try again.',
  'The menu words named a drink that is not on the plan. Try again.',
  'The menu words listed a drink twice. Try again.',
  'The menu words came back with a bad title. Try again.',
  'The menu words came back with a bad drink entry. Try again.',
  'The menu words picked a font pairing that does not exist. Try again.',
  'The menu words came back with a bad color palette. Try again.',
  'The menu words came back with a bad accent color. Try again.',
  'The menu words came back with a bad background name. Try again.',
  'OpenAI blocked this image for safety. Try a different note or art direction.',
  'Gemini blocked this image for safety.',
  'Gemini blocked this image as prohibited content.',
  'Gemini blocked a word or phrase in the prompt.',
  'Gemini blocked this content.',
  'Gemini stopped because the image was too close to an existing work.',
  'Gemini stopped drawing this image without saying why.',
  'Gemini answered without an image.',
  'Gemini could not finish this image.',
  'Gemini answered without a single image.',
  'Gemini blocked this image.',
  "Gemini didn't leave a clean background. Re-roll it.",
  'Gemini sent an image too large to process. Re-roll it.',
  'OpenAI blocked this image.',
  'OpenAI is busy right now. Re-roll in a minute.',
  'OpenAI could not draw this image. Re-roll it.',
  'Gemini is busy right now. Re-roll in a minute.',
  'Gemini could not draw this image. Re-roll it.',
  'The image service blocked this image.',
  'The image service is busy right now. Re-roll in a minute.',
  'The image service could not draw this image. Re-roll it.',
]);

// The words errors a new brief or art direction can cure; the card also
// offers the editor's Brief tab for them.
export const BRIEF_FIX_TEXTS = Object.freeze([
  'OpenAI declined to write this menu. Try different art direction.',
  'Anthropic declined to write this menu. Try a different brief.',
  'The menu words came back in the wrong shape. Try again.',
  'The menu words left out a drink. Try again.',
  'The menu words named a drink that is not on the plan. Try again.',
  'The menu words listed a drink twice. Try again.',
  'The menu words came back with a bad title. Try again.',
  'The menu words came back with a bad drink entry. Try again.',
  'The menu words picked a font pairing that does not exist. Try again.',
  'The menu words came back with a bad color palette. Try again.',
  'The menu words came back with a bad accent color. Try again.',
  'The menu words came back with a bad background name. Try again.',
]);

const FIXED = new Set(FIXED_TEXTS);

export const isFixedSentence = (text) => typeof text === 'string' && FIXED.has(text);
