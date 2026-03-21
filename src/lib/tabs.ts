import type { Page } from "playwright";

// ─── Tab Info ─────────────────────────────────────────────────────────────────

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  is_active: boolean;
}

// ─── Tab Management ─────────────────────────────────────────────────────────

export async function newTab(page: Page, url?: string): Promise<TabInfo> {
  const context = page.context();
  const newPage = await context.newPage();

  if (url) {
    await newPage.goto(url, { waitUntil: "domcontentloaded" });
  }

  const pages = context.pages();
  const index = pages.indexOf(newPage);

  return {
    index,
    url: newPage.url(),
    title: await newPage.title(),
    is_active: true,
  };
}

export async function listTabs(page: Page): Promise<TabInfo[]> {
  const context = page.context();
  const pages = context.pages();
  const activePage = page;

  const tabs: TabInfo[] = [];
  for (let i = 0; i < pages.length; i++) {
    let url = "";
    let title = "";
    try {
      url = pages[i].url();
      title = await pages[i].title();
    } catch {
      // Page may be closed or navigating
    }
    tabs.push({
      index: i,
      url,
      title,
      is_active: pages[i] === activePage,
    });
  }

  return tabs;
}

export async function switchTab(page: Page, index: number): Promise<{ page: Page; tab: TabInfo }> {
  const context = page.context();
  const pages = context.pages();

  if (index < 0 || index >= pages.length) {
    throw new Error(`Tab index ${index} out of range (0-${pages.length - 1})`);
  }

  const targetPage = pages[index];
  await targetPage.bringToFront();

  return {
    page: targetPage,
    tab: {
      index,
      url: targetPage.url(),
      title: await targetPage.title(),
      is_active: true,
    },
  };
}

export async function closeTab(page: Page, index: number): Promise<{ closed_index: number; active_tab: TabInfo }> {
  const context = page.context();
  const pages = context.pages();

  if (index < 0 || index >= pages.length) {
    throw new Error(`Tab index ${index} out of range (0-${pages.length - 1})`);
  }

  if (pages.length <= 1) {
    throw new Error("Cannot close the last tab");
  }

  const targetPage = pages[index];
  const isActivePage = targetPage === page;

  await targetPage.close();

  // After closing, determine the new active tab
  const remainingPages = context.pages();
  const activeIndex = isActivePage
    ? Math.min(index, remainingPages.length - 1)
    : remainingPages.indexOf(page);

  const activePage = remainingPages[activeIndex >= 0 ? activeIndex : 0];

  return {
    closed_index: index,
    active_tab: {
      index: activeIndex >= 0 ? activeIndex : 0,
      url: activePage.url(),
      title: await activePage.title(),
      is_active: true,
    },
  };
}
