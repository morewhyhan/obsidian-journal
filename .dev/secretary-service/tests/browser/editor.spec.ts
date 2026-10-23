import { test, expect, type Page } from "@playwright/test";
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("访问密码").fill("local-demo-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "把今天，过得清楚一点。" }),
  ).toBeVisible();
}
async function create(page: Page, content: string) {
  const path = "03. Manual/browser-" + crypto.randomUUID() + ".md";
  const response = await page.request.post("/api/v1/documents", {
    headers: {
      Origin: "http://127.0.0.1:3187",
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: { path, content },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/notes?path=" + encodeURIComponent(path));
  await expect(
    page.getByRole("textbox", { name: "Markdown 正文" }),
  ).toBeVisible();
  return path;
}
test("U01 desktop, tablet and phone render usable navigation without horizontal overflow", async ({
  page,
}) => {
  await login(page);
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const cards = page.locator(".space");
    await expect(cards).toHaveCount(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    if (width === 1440) {
      const first = await cards.nth(0).boundingBox(),
        second = await cards.nth(1).boundingBox(),
        third = await cards.nth(2).boundingBox();
      expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
      expect(Math.abs(first!.y - third!.y)).toBeLessThan(2);
    }
    await page.screenshot({
      path: `test-results/home-${width}.png`,
      fullPage: true,
    });
  }
});
test("D01/U02 source editing saves exact content and supports undo", async ({
  page,
}) => {
  await login(page);
  const p = await create(page, "# 测试笔记\n\n原始内容\n");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n追加自己的想法");
  await expect
    .poll(async () => {
      const r = await page.request.get(
        "/api/v1/documents?path=" + encodeURIComponent(p),
      );
      return (await r.json()).content;
    })
    .toContain("追加自己的想法");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(editor).not.toContainText("追加自己的想法");
});
test("U02 interrupted save leaves an IndexedDB draft that survives reload", async ({
  page,
  context,
}) => {
  await login(page);
  const p = await create(page, "# 草稿恢复\n");
  await context.setOffline(true);
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n离线仍然保留的文字");
  await page.waitForTimeout(1600);
  await context.setOffline(false);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Markdown 正文" }),
  ).toContainText("离线仍然保留的文字");
  await expect
    .poll(async () => {
      const r = await page.request.get(
        "/api/v1/documents?path=" + encodeURIComponent(p),
      );
      return (await r.json()).content;
    })
    .toContain("离线仍然保留的文字");
});
test("U02 composing Chinese text is not auto-saved before composition ends", async ({
  page,
}) => {
  await login(page);
  const p = await create(page, "# 输入法\n");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await editor.dispatchEvent("compositionstart");
  await page.keyboard.insertText("\n中文组合输入");
  await page.waitForTimeout(1400);
  const mid = await (
    await page.request.get("/api/v1/documents?path=" + encodeURIComponent(p))
  ).json();
  expect(mid.content).not.toContain("中文组合输入");
  await editor.dispatchEvent("compositionend");
  await expect
    .poll(async () => {
      const r = await page.request.get(
        "/api/v1/documents?path=" + encodeURIComponent(p),
      );
      return (await r.json()).content;
    })
    .toContain("中文组合输入");
});
test("D02 remote save does not replace an unsaved local draft", async ({
  page,
}) => {
  await login(page);
  const p = await create(page, "# 版本冲突\n\n原文\n");
  const initial = await (
    await page.request.get("/api/v1/documents?path=" + encodeURIComponent(p))
  ).json();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await editor.dispatchEvent("compositionstart");
  await page.keyboard.insertText("\n我的未提交草稿");
  await page.request.put("/api/v1/documents", {
    headers: {
      Origin: "http://127.0.0.1:3187",
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      path: p,
      base_hash: initial.hash,
      content: initial.content + "\n服务器新的勾选记录",
    },
  });
  await expect(
    page.getByRole("heading", { name: "这篇笔记在别处更新了" }),
  ).toBeVisible();
  await editor.dispatchEvent("compositionend");
  await expect(editor).toContainText("我的未提交草稿");
  await page.getByText("查看服务器当前内容").click();
  await expect(page.locator(".conflict pre")).toContainText(
    "服务器新的勾选记录",
  );
  const current = await (
    await page.request.get("/api/v1/documents?path=" + encodeURIComponent(p))
  ).json();
  expect(current.content).not.toContain("我的未提交草稿");
});
test("D07 deleted notes can be recovered from settings with their exact content", async ({
  page,
}) => {
  await login(page);
  const p = await create(page, "# 删除后恢复\n\n仍然完整的原文\n");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("更多笔记操作").click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "把今天，过得清楚一点。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置与状态", exact: true }).click();
  await page.getByRole("button", { name: "最近删除", exact: true }).click();
  await page
    .locator(".setting-row")
    .filter({ hasText: p.split("/").at(-1)!.replace(".md", "") })
    .getByRole("button", { name: "恢复", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 正文" }),
  ).toContainText("仍然完整的原文");
});
test("C04 preview displays scripts as inert content and never loads code-block embeds", async ({
  page,
}) => {
  await login(page);
  await create(
    page,
    "# 安全预览\n\n<script>window.__noteScriptRan=true</script>\n\n```dataviewjs\nwindow.__dynamicScriptRan=true\n```\n\n```md\n![[03. Manual/not-authorized]]\n```\n",
  );
  let loaded = false;
  page.on("request", (request) => {
    if (request.url().includes("not-authorized")) loaded = true;
  });
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator(".markdown-preview")).toContainText(
    "此动态区块在 Obsidian 中运行",
  );
  expect(
    await page.evaluate(() =>
      Boolean(
        (window as any).__noteScriptRan || (window as any).__dynamicScriptRan,
      ),
    ),
  ).toBe(false);
  expect(loaded).toBe(false);
});
test("direct /items link opens the requested page after authentication", async ({
  page,
}) => {
  await login(page);
  await page.goto("/items");
  await expect(
    page.getByRole("heading", { name: "今天，做一点。" }),
  ).toBeVisible();
});

test("opening a missing calendar link creates the complete template instead of a blank note", async ({
  page,
}) => {
  await login(page);
  const p = "01. Daily/2097年/第1季度/01月/2097-W01/2097-01-01.md";
  await page.goto("/notes?path=" + encodeURIComponent(p));
  await page
    .getByRole("dialog", { name: "新建笔记" })
    .getByRole("button", { name: "创建笔记", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor).toContainText("# 随笔");
  await expect(editor).toContainText("type: daily");
  await expect(editor).not.toContainText("<%");
  const tree = await (await page.request.get("/api/v1/tree")).json();
  expect(tree.paths).toContain("01. Daily/2097年/年度计划.md");
  expect(tree.paths).toContain("01. Daily/2097年/第1季度/01月/月度计划.md");
});
test("Git history can be previewed and restored as a new file save", async ({
  page,
}) => {
  await login(page);
  await page.goto(
    "/notes?path=" + encodeURIComponent("03. Manual/开始一个小动作.md"),
  );
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n本轮修改");
  await expect
    .poll(async () => {
      const doc = await page.request.get(
        "/api/v1/documents?path=" +
          encodeURIComponent("03. Manual/开始一个小动作.md"),
      );
      return (await doc.json()).content;
    })
    .toContain("本轮修改");
  await page.getByLabel("版本历史").click();
  const dialog = page.getByRole("dialog", { name: "版本历史" });
  await expect(dialog.locator(".history-version")).toHaveCount(1);
  await dialog.locator(".history-version").click();
  await expect(dialog.locator(".history-preview")).toContainText("把事情变小");
  await dialog.getByRole("button", { name: "将此版本恢复为当前内容" }).click();
  await expect(editor).not.toContainText("本轮修改");
  await expect(editor).toContainText("把事情变小");
});

test("a delayed update for the previous note cannot replace the currently open note", async ({
  page,
}) => {
  await login(page);
  const first = await create(page, "# 第一篇\n原文A\n");
  const second = "03. Manual/race-" + crypto.randomUUID() + ".md";
  const created = await page.request.post("/api/v1/documents", {
    headers: {
      Origin: "http://127.0.0.1:3187",
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: { path: second, content: "# 第二篇\n原文B\n" },
  });
  expect(created.ok()).toBe(true);
  // The browser's SSE-triggered document read is held until navigation completes.
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      started = r;
    });
  await page.route("**/api/v1/documents?path=*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") === first) {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  const current = await (
    await page.request.get(
      "/api/v1/documents?path=" + encodeURIComponent(first),
    )
  ).json();
  await page.request.put("/api/v1/documents", {
    headers: {
      Origin: "http://127.0.0.1:3187",
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      path: first,
      base_hash: current.hash,
      content: "# 第一篇\n外部更新A\n",
    },
  });
  await ready;
  await page.getByRole("button", { name: "搜索笔记" }).click();
  await page
    .getByLabel("搜索关键词")
    .fill(second.split("/").at(-1)!.replace(".md", ""));
  await page
    .locator(".search-results button")
    .filter({ hasText: second.split("/").at(-1)!.replace(".md", "") })
    .click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor).toContainText("原文B");
  release();
  await page.waitForTimeout(300);
  await expect(editor).toContainText("原文B");
  await expect(editor).not.toContainText("外部更新A");
});
