"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 予算値は v0.1.0 でのコンテキストダイエット完了後の実測
// （description 最大112字・本文 最大5,770字）に成長余地を足して決定。
// 超過はスキル再肥大のシグナルとして CI で機械的に検出する。
const DESCRIPTION_BUDGET = 250;
const BODY_BUDGET = 10000;

const REPO_ROOT = path.join(__dirname, "..");

function countChars(text) {
  // "字" 基準で数えるため UTF-16 コードユニットではなくコードポイントで数える
  return [...text].length;
}

function parseSkillMd(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { description: null, body: text };
  }
  const descriptionLine = match[1].match(/^description:\s*(.*)$/m);
  let description = descriptionLine ? descriptionLine[1].trim() : null;
  if (description && /^(["']).*\1$/.test(description)) {
    description = description.slice(1, -1);
  }
  return { description, body: match[2] };
}

function checkBudget(raw) {
  const { description, body } = parseSkillMd(raw);
  const violations = [];
  if (description === null) {
    violations.push("frontmatter に description がありません");
  } else if (countChars(description) > DESCRIPTION_BUDGET) {
    violations.push(
      `description が ${countChars(description)} 字で予算 ${DESCRIPTION_BUDGET} 字を超過しています。` +
        "一行の目的と when use トリガー例文だけに絞ってください"
    );
  }
  if (countChars(body) > BODY_BUDGET) {
    violations.push(
      `本文が ${countChars(body)} 字で予算 ${BODY_BUDGET} 字を超過しています。` +
        "背景・理由・実測談は同ディレクトリの reference.md へ分離してください"
    );
  }
  return violations;
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function collectSkillFiles(root) {
  // plugins/*/skills/*/SKILL.md — 新規プラグイン・新規スキルにも自動適用される
  const files = [];
  const pluginsDir = path.join(root, "plugins");
  for (const plugin of listDirs(pluginsDir)) {
    const skillsDir = path.join(pluginsDir, plugin, "skills");
    for (const skill of listDirs(skillsDir)) {
      const skillMd = path.join(skillsDir, skill, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        files.push(skillMd);
      }
    }
  }
  return files;
}

function makeSkillMd({ description, body }) {
  return `---\nname: fixture\ndescription: "${description}"\n---\n${body}`;
}

test("parseSkillMd extracts a quoted description and the body after frontmatter", () => {
  const parsed = parseSkillMd('---\nname: x\ndescription: "目的。 when use: 例"\n---\n# 本文\n');
  assert.equal(parsed.description, "目的。 when use: 例");
  assert.equal(parsed.body, "# 本文\n");
});

test("parseSkillMd handles an unquoted description and CRLF line endings", () => {
  const parsed = parseSkillMd("---\r\nname: x\r\ndescription: 目的\r\n---\r\n本文\r\n");
  assert.equal(parsed.description, "目的");
  assert.equal(parsed.body, "本文\n");
});

test("checkBudget passes a skill within both budgets", () => {
  assert.deepEqual(checkBudget(makeSkillMd({ description: "短い説明", body: "短い本文" })), []);
});

test("checkBudget flags a description over budget", () => {
  const violations = checkBudget(
    makeSkillMd({ description: "あ".repeat(DESCRIPTION_BUDGET + 1), body: "本文" })
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /description が 251 字で予算 250 字を超過/);
});

test("checkBudget flags a body over budget and points to reference.md as the escape hatch", () => {
  const violations = checkBudget(
    makeSkillMd({ description: "説明", body: "あ".repeat(BODY_BUDGET + 1) })
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /reference\.md へ分離/);
});

test("checkBudget flags a SKILL.md without a description", () => {
  const violations = checkBudget("---\nname: x\n---\n本文");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /description がありません/);
});

test("collectSkillFiles finds SKILL.md across plugins and skills, and an oversized fixture goes red end-to-end", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-size-"));
  try {
    const skillDir = path.join(root, "plugins", "some-plugin", "skills", "some-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      makeSkillMd({ description: "説明", body: "あ".repeat(BODY_BUDGET + 1) })
    );
    const files = collectSkillFiles(root);
    assert.equal(files.length, 1);
    assert.notDeepEqual(checkBudget(fs.readFileSync(files[0], "utf8")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every SKILL.md in this repository stays within the size budget", () => {
  const files = collectSkillFiles(REPO_ROOT);
  // globの走査自体が壊れてテストが空振りで green になるのを防ぐ
  assert.ok(files.length > 0, "plugins/*/skills/*/SKILL.md が1件も見つかりません");
  for (const file of files) {
    const violations = checkBudget(fs.readFileSync(file, "utf8"));
    assert.deepEqual(
      violations,
      [],
      `${path.relative(REPO_ROOT, file)}: ${violations.join(" / ")}`
    );
  }
});
