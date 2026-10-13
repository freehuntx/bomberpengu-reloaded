import assert from 'node:assert/strict'
import { browserLanguage, selectLanguage, translations, translateError, translateServerMessage } from '../src/game/i18n.ts'

for (const language of ['de', 'de-DE', 'de-AT', 'de-CH', 'DE-de', ' de_DE ']) assert.equal(selectLanguage(language), 'de')
for (const language of ['en', 'en-US', 'en-GB', 'fr-FR', 'ja-JP', 'deutsch', '', null, undefined]) assert.equal(selectLanguage(language), 'en')

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
try {
  for (const [languages, language, expected] of [
    [['de-CH', 'en'], 'en-US', 'de'],
    [['en-GB', 'de'], 'de-DE', 'en'],
    [['fr-FR', 'de-DE'], 'fr-FR', 'en'],
    [[], 'de-AT', 'de'],
    [[], '', 'en'],
  ]) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages, language } })
    assert.equal(browserLanguage(), expected)
  }
} finally {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  else delete globalThis.navigator
}

assert.deepEqual(Object.keys(translations.de).sort(), Object.keys(translations.en).sort())
for (const catalog of Object.values(translations)) {
  assert.equal(catalog.legend.length, 7)
  assert.deepEqual(Object.keys(catalog.actions).sort(), ['0','1','2','3','13','23','5'].sort())
  for (const value of Object.values(catalog)) if (typeof value === 'string') assert.ok(value.trim())
  const name = '<Alice & Bob>'
  for (const format of [catalog.opponentLeft, catalog.opponentRematch, catalog.waitingFor]) assert.ok(format(name).includes(name))
}
assert.deepEqual(Object.keys(translations.de.notices).sort(), Object.keys(translations.en.notices).sort())
assert.deepEqual(Object.keys(translations.de.errors).sort(), Object.keys(translations.en.errors).sort())
assert.equal(translateServerMessage('System', 'Starting freestyle!', 'de'), 'Freestyle wird gestartet!')
assert.equal(translateServerMessage('System', 'Starting freestyle!', 'en'), 'Starting freestyle!')
assert.equal(translateServerMessage('!h|!help', 'Show this help', 'de'), 'Diese Hilfe anzeigen')
assert.equal(translateServerMessage('Alice', 'Starting freestyle!', 'de'), 'Starting freestyle!', 'player messages must not be translated')
assert.equal(translateServerMessage('System', 'A custom welcome message', 'de'), 'A custom welcome message')
assert.equal(translateError('Missing name!', 'de'), 'Benutzername fehlt!')
assert.equal(translateError('An unknown server error', 'de'), 'An unknown server error')

console.log('✔ bomberpengu localization: browser preferences, regional German, English fallback, complete catalogs, local notices and untouched player chat')
