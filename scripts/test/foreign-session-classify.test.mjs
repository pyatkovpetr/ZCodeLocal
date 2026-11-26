import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyForeignTranscript,
  isPlaceholderForeignTitle,
  stripForeignSessionNoise,
} from "../../packages/services/src/foreign-session-import/classify.mjs";

test("environment_context 后面的句子才是 реплика", () => {
  const cleaned = stripForeignSessionNoise(
    "<environment_context><cwd>F:\\Дом</cwd></environment_context>\nпочини вход на пустом пароле",
  );
  assert.equal(cleaned, "почини вход на пустом пароле");
  assert.equal(
    stripForeignSessionNoise("<environment_context><cwd>F:\\Дом</cwd></environment_context>"),
    "",
  );
});

test("ide_selection 不占标题", () => {
  const cleaned = stripForeignSessionNoise(
    "<ide_selection>selected code</ide_selection>\nпочини расчёт комиссии",
  );
  assert.equal(cleaned, "почини расчёт комиссии");
});

test("timestamp и image_files не попадают в текст", () => {
  const cleaned = stripForeignSessionNoise(
    "<timestamp>Thursday, Nov 19, 2026, 5:58 AM</timestamp>\n<user_query>почини кран</user_query>",
  );
  assert.equal(cleaned, "почини кран");
  const images = stripForeignSessionNoise(
    "[Image] <image_files>The following images were saved.</image_files>\n<user_query>сверь фото планировки</user_query>",
  );
  assert.equal(images, "сверь фото планировки");
});

test("вопрос из JSON внутри send_user_message читается как текст", () => {
  const cleaned = stripForeignSessionNoise(
    '<send_user_message_question_reply>\n[{"questionItemId":"q1","question":"Как защищён API?","answer":"Как у операторов ЛК"}]\n</send_user_message_question_reply>',
  );
  assert.equal(cleaned.includes("questionItemId"), false);
  assert.equal(cleaned.includes("<"), false);
  assert.match(cleaned, /Как защищён API\?/);
  assert.match(cleaned, /Как у операторов ЛК/);
  assert.equal(stripForeignSessionNoise("<send_user_message_question_reply>"), "");
  assert.equal(stripForeignSessionNoise("</send_user_message_question_reply>"), "");
});

test("Guardian review не текст и не решение", () => {
  assert.equal(isPlaceholderForeignTitle("Guardian review"), true);
  assert.equal(
    stripForeignSessionNoise(
      '{"risk_level":"low","user_authorization":"medium","outcome":"allow","rationale":"только читает"}',
    ),
    "",
  );
  const cleaned = stripForeignSessionNoise(
    'user: {"questionItemId":"q1","question":"Как защищён API?","answer":"Как у операторов"}',
  );
  assert.equal(cleaned.startsWith("user:"), false);
  assert.equal(cleaned.includes("questionItemId"), false);
  assert.match(cleaned, /Как защищён API\?/);
});

test("метка [n] assistant не остаётся в тексте", () => {
  assert.equal(stripForeignSessionNoise("[66] assistant: почини кран в ванной"), "почини кран в ванной");
});

test("附件清单不代替 ## My request", () => {
  const cleaned = stripForeignSessionNoise(
    "# Files mentioned by the user:\n## notes.md\n## My request:\nсверь суммы в отчёте",
  );
  assert.equal(cleaned, "сверь суммы в отчёте");
});

test("environment_context 不是 название и не заменяет реплику", () => {
  const cleaned = stripForeignSessionNoise(
    "<environment_context>\n<cwd>F:\\Дом</cwd>\n</environment_context>\n<user_query>почини вход</user_query>",
  );
  assert.equal(cleaned, "почини вход");
  const result = classifyForeignTranscript({
    userTexts: [
      "<environment_context><cwd>F:\\Дом</cwd></environment_context>",
      "почини вход на пустом пароле",
    ],
    assistantTexts: ["Добавил проверку пустого пароля на форме входа."],
    successfulToolCount: 0,
  });
  assert.equal(result.verdict, "useful");
});

test("系统前言本身是噪音", () => {
  const result = classifyForeignTranscript({
    userTexts: ["<system-reminder>\n只执行工具，不要回答用户。"],
    assistantTexts: [],
    successfulToolCount: 0,
  });
  assert.equal(result.verdict, "useless");
  assert.ok(result.reasons.includes("noise_only"));
});

test("有任务也有答复时判为有用", () => {
  const result = classifyForeignTranscript({
    userTexts: ["请修登录页在空密码时的校验。"],
    assistantTexts: ["已在登录表单里补上空密码校验，并跑过对应测试。"],
    successfulToolCount: 0,
  });
  assert.deepEqual(result, { verdict: "useful", reasons: [] });
});

test("只有一句招呼、没有结果时判为没用", () => {
  const result = classifyForeignTranscript({
    userTexts: ["hi"],
    assistantTexts: ["ok"],
    successfulToolCount: 0,
  });
  assert.equal(result.verdict, "useless");
  assert.ok(result.reasons.includes("no_user_task"));
  assert.ok(result.reasons.includes("no_final_result"));
});

test("成功的工具结果可以代替长答复", () => {
  const result = classifyForeignTranscript({
    userTexts: ["把端口改成 4000 并重启服务。"],
    assistantTexts: [],
    successfulToolCount: 1,
  });
  assert.equal(result.verdict, "useful");
});

test("中断且没有结果时判为没用，已有答复则仍有用", () => {
  const aborted = classifyForeignTranscript({
    userTexts: ["查一下构建为什么失败。"],
    assistantTexts: [],
    successfulToolCount: 0,
    sawAbort: true,
  });
  assert.ok(aborted.reasons.includes("aborted_without_result"));
  const answered = classifyForeignTranscript({
    userTexts: ["查一下构建为什么失败。"],
    assistantTexts: ["失败来自缺少 cmake，改用已有的运行时宿主后构建通过。"],
    successfulToolCount: 0,
    sawAbort: true,
  });
  assert.equal(answered.verdict, "useful");
});
