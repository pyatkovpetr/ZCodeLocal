import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cursorProjectSlug,
  cursorSlugFromTranscript,
} from "../../packages/services/src/foreign-session-import/sessionFiles.ts";

test("Cursor 目录名和真实路径是同一个项目", () => {
  assert.equal(cursorProjectSlug("D:\\WORK\\ORION\\Orion"), "d-WORK-ORION-Orion");
  assert.equal(cursorProjectSlug("E:\\02_Projects\\aidesk"), "e-02-Projects-aidesk");
  assert.equal(cursorProjectSlug("D:\\04_Software\\ZCodePortable"), "d-04-Software-ZCodePortable");
  assert.equal(
    cursorSlugFromTranscript(
      "C:\\Users\\Petr\\.cursor\\projects\\d-WORK-ORION-Orion\\agent-transcripts\\a\\a.jsonl",
    ),
    "d-WORK-ORION-Orion",
  );
});
