/**
 * 无模型的会话有用性判断。
 * 依据 Orion 知识库导入：history_labels.noise 的三种系统前言，
 * 以及 history_outcomes.evaluate 里不依赖人工或模型标注的结构条件
 * （没有用户任务、没有最终结果、中断且没有结果）。
 */

const NOISE_PREFIXES = [
  "The following is the Codex agent history",
  "<system-reminder>",
  "<in-app-browser-context",
];

const DROP_TAGS = [
  "environment_context",
  "ide_selection",
  "ide_opened_file",
  "open_and_recently_viewed_files",
  "attached_files",
  "timestamp",
  "skills_instructions",
  "system-reminder",
  "system_reminder",
  "in-app-browser-context",
  "recommended_plugins",
  "external_codex_apps_open_page",
  "image",
  "image_files",
  "image_file",
  "external_links",
  "turn_aborted",
  "task-notification",
  "tool_use_error",
];

const UNWRAP_TAGS = ["user_query", "send_user_message_question_reply", "send_user_message"];

const JSON_TEXT_KEYS = ["question", "prompt", "text", "content", "answer"];

const REQUEST_HEADINGS = ["## My request for Codex:", "## My request:"];

const USER_MIN_CHARS = 8;
const ASSISTANT_MIN_CHARS = 12;

function stripEnvelope(value, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  let current = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current.replace(pattern, "");
    if (next === current) return current;
    current = next;
  }
  return current;
}

function unwrapEnvelope(value, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return value.replace(pattern, (_whole, inner) => inner);
}

function dropTagLines(value, tags) {
  const names = new Set(tags.map((tag) => tag.toLowerCase()));
  return value
    .split("\n")
    .filter((line) => {
      const match = line.trim().match(/^<\/?([A-Za-z][\w:-]*)\b[^>]*>$/);
      if (!match) return true;
      return !names.has(match[1].toLowerCase());
    })
    .join("\n");
}

function readableJson(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const bits = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const key of JSON_TEXT_KEYS) {
      if (typeof node[key] === "string" && node[key].trim()) bits.push(node[key].trim());
    }
  };
  visit(parsed);
  return bits.length > 0 ? bits.join("\n\n") : null;
}

export function stripForeignSessionNoise(text) {
  let value = String(text ?? "").replace(/\r\n/g, "\n").trim();
  // 来源把日期、图片、环境和问题回复包在标签里。这些标签不是用户的话。
  value = value.replace(/^\s*(?:\[Image\]\s*)+/i, "");
  value = value.replace(/\n(?:\[Image\]\s*)+/gi, "\n");
  for (const tag of DROP_TAGS) value = stripEnvelope(value, tag);
  for (const tag of UNWRAP_TAGS) value = unwrapEnvelope(value, tag);
  const lineTags = [...DROP_TAGS, ...UNWRAP_TAGS].filter(
    (tag) => !NOISE_PREFIXES.some((prefix) => prefix.startsWith(`<${tag}`)),
  );
  value = dropTagLines(value, lineTags);
  const fromJson = readableJson(value);
  if (fromJson) value = fromJson;
  let requestAt = -1;
  let requestHeading = "";
  for (const heading of REQUEST_HEADINGS) {
    const at = value.lastIndexOf(heading);
    if (at > requestAt) {
      requestAt = at;
      requestHeading = heading;
    }
  }
  if (requestAt >= 0) value = value.slice(requestAt + requestHeading.length);
  const query = value.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (query) value = query[1];
  value = value.trim();
  let changed = true;
  while (changed && value) {
    changed = false;
    for (const prefix of NOISE_PREFIXES) {
      if (!value.startsWith(prefix)) continue;
      const splitAt = value.indexOf("\n\n");
      value = (splitAt >= 0 ? value.slice(splitAt + 2) : "").trim();
      changed = true;
      break;
    }
  }
  value = replaceQuestionBlobs(value);
  value = dropGuardianDecision(value);
  value = value.replace(/\[\d+\]\s*(?:user|assistant|system)\s*:\s*/gi, "");
  return stripRoleLabels(value);
}

const PLACEHOLDER_TITLES = new Set(["guardian review", "new session", "untitled", "new thread"]);

export function isPlaceholderForeignTitle(value) {
  return PLACEHOLDER_TITLES.has(String(value ?? "").trim().toLowerCase());
}

function sliceJsonObject(value, start) {
  if (value[start] !== "{") return "";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return "";
}

function unescapeJsonString(value) {
  return value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function looseQuestionText(blob) {
  const take = (key) =>
    [...blob.matchAll(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "g"))].map((match) =>
      unescapeJsonString(match[1] ?? ""),
    );
  return ["question", "answer", "prompt", "text"].flatMap(take).filter(Boolean).join("\n\n");
}

function replaceQuestionBlobs(value) {
  if (!value.includes("questionItemId")) return value;
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("{", cursor);
    if (start < 0) {
      result += value.slice(cursor);
      break;
    }
    const blob = sliceJsonObject(value, start);
    if (!blob || !blob.includes("questionItemId")) {
      result += value.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }
    result += value.slice(cursor, start);
    result += looseQuestionText(blob);
    cursor = start + blob.length;
  }
  return result;
}

function dropGuardianDecision(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "risk_level" in parsed &&
      "outcome" in parsed
    ) {
      return "";
    }
  } catch {
    // 不是 целый JSON решения.
  }
  return value;
}

function stripRoleLabels(value) {
  let current = value.trim();
  let changed = true;
  while (changed) {
    const next = current.replace(/^(?:\[\d+\]\s*)?(?:user|assistant|system)\s*:\s*/i, "");
    changed = next !== current;
    current = next.trim();
  }
  return current;
}

export function classifyForeignTranscript(input) {
  const userTexts = Array.isArray(input?.userTexts) ? input.userTexts : [];
  const assistantTexts = Array.isArray(input?.assistantTexts) ? input.assistantTexts : [];
  const successfulToolCount = Number(input?.successfulToolCount) || 0;
  const reasons = [];
  let sawNoise = false;
  let sawOtherUser = false;
  let substantiveUser = false;
  for (const text of userTexts) {
    const raw = String(text ?? "").trim();
    const stripped = stripForeignSessionNoise(raw);
    if (!stripped) {
      if (raw) sawNoise = true;
      continue;
    }
    sawOtherUser = true;
    if (stripped.length >= USER_MIN_CHARS) substantiveUser = true;
  }
  const substantiveAssistant = assistantTexts.some(
    (text) => stripForeignSessionNoise(text).length >= ASSISTANT_MIN_CHARS,
  );
  const hasResult = substantiveAssistant || successfulToolCount > 0;
  if (sawNoise && !sawOtherUser) reasons.push("noise_only");
  if (!substantiveUser) reasons.push("no_user_task");
  if (!hasResult) reasons.push("no_final_result");
  if (input?.sawAbort && !hasResult) reasons.push("aborted_without_result");
  return {
    verdict: reasons.length === 0 ? "useful" : "useless",
    reasons,
  };
}
