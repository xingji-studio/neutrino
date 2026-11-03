// The web console's interface language is part of its public contract: every
// static label and every literal passed to t()/tr() must have a Chinese
// translation, and placeholders must survive translation unchanged.
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyTranslations, hasTranslation, LANGUAGES, normalizeLanguage, setLanguage, t } from "../web/i18n.js";

const sources = new Set();
const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
for (const match of html.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria-label)?="((?:[^"\\]|\\.)*)"/g)) {
  sources.add(match[1]);
}
for (const file of ["../web/app.js", "../web/settings.js"]) {
  const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  for (const match of text.matchAll(/\b(?:tr|t)\(\s*"((?:[^"\\]|\\.)*)"/g)) sources.add(match[1]);
}

assert.ok(sources.size > 80, "the scan found the console's labels");
const missing = [...sources].filter(source => !hasTranslation(source));
assert.deepEqual(missing, [], `missing Chinese translations: ${missing.join(", ")}`);

const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
setLanguage("zh");
for (const source of sources) {
  const translated = t(source);
  assert.notEqual(translated, undefined);
  if (source === "Neutrino") continue;
  assert.ok(translated.length > 0, `${source} has a translation`);
  assert.deepEqual(placeholders(translated), placeholders(source), `placeholders survive: ${source}`);
}

assert.deepEqual(LANGUAGES.map(entry => entry.value), ["en", "zh"]);
assert.equal(normalizeLanguage("zh-CN"), "zh");
assert.equal(normalizeLanguage("EN"), "en");
assert.equal(normalizeLanguage("fr"), "en");
assert.equal(t("Settings"), "设置");
assert.equal(t("You: {text}", { text: "hello" }), "你：hello");
assert.equal(t("Working directory: {path}", { path: "C:\\project" }), "工作目录：C:\\project");
assert.equal(t("This source is not translated yet"), "This source is not translated yet");
assert.equal(t("Neutrino"), "Neutrino");

setLanguage("en");
assert.equal(t("Settings"), "Settings");
assert.equal(t("You: {text}", { text: "hello" }), "You: hello");
assert.equal(t("Neutrino"), "Neutrino");

// Applying translations rewrites text and attributes from their source values,
// and never depends on the previous language.
function fakeNode(attributes) {
  return {
    title: "",
    placeholder: "",
    textContent: "",
    attributes,
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}
const textNode = fakeNode({ "data-i18n": "Settings" });
const titleNode = fakeNode({ "data-i18n-title": "Refresh conversations" });
const placeholderNode = fakeNode({ "data-i18n-placeholder": "Message Neutrino…" });
const ariaNode = fakeNode({ "data-i18n-aria-label": "Settings" });
const root = {
  querySelectorAll(selector) {
    return {
      "[data-i18n]": [textNode],
      "[data-i18n-html]": [],
      "[data-i18n-title]": [titleNode],
      "[data-i18n-placeholder]": [placeholderNode],
      "[data-i18n-aria-label]": [ariaNode],
    }[selector] ?? [];
  },
};
setLanguage("zh");
applyTranslations(root);
assert.equal(textNode.textContent, "设置");
assert.equal(titleNode.title, "刷新会话");
assert.equal(placeholderNode.placeholder, "向 Neutrino 发送消息…");
assert.equal(ariaNode.attributes["aria-label"], "设置");
setLanguage("en");
applyTranslations(root);
assert.equal(textNode.textContent, "Settings");
assert.equal(titleNode.title, "Refresh conversations");
assert.equal(ariaNode.attributes["aria-label"], "Settings");

console.log("ok web i18n: complete dictionary, stable placeholders and bidirectional DOM application");
