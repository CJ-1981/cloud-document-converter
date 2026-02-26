export interface DownloadDocumentOptions {
  timeout?: number
  onPageLoadTimeout?: () => void
  onDownloadTimeout?: () => void
}

export interface DownloadDocumentResult {
  success: boolean
  error?: string
  title?: string
}

/**
 * Download a document by opening a tab, injecting the download script,
 * and waiting for completion
 */
export async function downloadDocument(
  url: string,
  options: DownloadDocumentOptions = {},
): Promise<DownloadDocumentResult> {
  const { timeout = 60000, onPageLoadTimeout, onDownloadTimeout } = options

  let tab: chrome.tabs.Tab | null = null

  try {
    // Create new tab (inactive/background)
    tab = await chrome.tabs.create({ url, active: false })

    if (!tab.id) {
      return { success: false, error: 'Failed to create tab' }
    }

    // Wait for page load
    await waitForPageLoad(tab.id, timeout, onPageLoadTimeout)

    // Set automation flag
    await chrome.scripting.executeScript({
      func: () => {
        // @ts-expect-error - Automation mode flag
        window.__AUTOMATION_MODE__ = true
      },
      target: { tabId: tab.id },
    })

    // Inject download script
    await chrome.scripting.executeScript({
      files: ['bundles/scripts/download-lark-docx-as-markdown.js'],
      target: { tabId: tab.id },
      world: 'MAIN',
    })

    // Wait for download to complete
    await waitForDownloadComplete(timeout, onDownloadTimeout)

    // Try to get the title from the page
    const titleResults = await chrome.scripting.executeScript({
      func: getPageTitle,
      target: { tabId: tab.id },
    })

    const title = titleResults[0]?.result as string | undefined

    return { success: true, title }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    // Always close the tab
    if (tab?.id) {
      await chrome.tabs.remove(tab.id).catch(() => {
        // Ignore errors when closing tab
      })
    }
  }
}

/**
 * Get page title from the document
 */
function getPageTitle(): string | undefined {
  // Try to get title from Lark's global state
  // @ts-expect-error - Lark global
  if (window.PageMain?.blockManager?.rootBlockModel?.title) {
    // @ts-expect-error - Lark global
    return window.PageMain.blockManager.rootBlockModel.title
  }

  // Fallback to document title
  return document.title
}

/**
 * Wait for a page to complete loading
 */
function waitForPageLoad(
  tabId: number,
  timeout: number,
  onTimeout?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false

    const listener = (tabId_: number, changeInfo: any) => {
      if (!resolved && tabId_ === tabId && changeInfo.status === 'complete') {
        resolved = true
        chrome.tabs.onUpdated.removeListener(listener as any)
        resolve()
      }
    }

    chrome.tabs.onUpdated.addListener(listener as any)

    // Check if already complete
    chrome.tabs
      .get(tabId)
      .then(tab => {
        if (!resolved && tab.status === 'complete') {
          resolved = true
          chrome.tabs.onUpdated.removeListener(listener as any)
          resolve()
        }
      })
      .catch(error => {
        if (!resolved) {
          resolved = true
          chrome.tabs.onUpdated.removeListener(listener as any)
          reject(error)
        }
      })

    // Timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        chrome.tabs.onUpdated.removeListener(listener as any)
        onTimeout?.()
        reject(new Error('Page load timeout'))
      }
    }, timeout)
  })
}

/**
 * Wait for a download to complete by monitoring chrome.downloads
 */
function waitForDownloadComplete(
  timeout: number,
  onTimeout?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false

    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (resolved) return

      if (delta.state && delta.state.current === 'complete') {
        resolved = true
        chrome.downloads.onChanged.removeListener(listener as any)
        resolve()
      } else if (delta.error && delta.error.current !== undefined) {
        resolved = true
        chrome.downloads.onChanged.removeListener(listener as any)
        reject(new Error(`Download error: ${delta.error.current}`))
      }
    }

    chrome.downloads.onChanged.addListener(listener as any)

    // Also check if there are any recent downloads that might be ours
    // This handles the case where download completes before we attach listener
    chrome.downloads
      .search({
        orderBy: ['-startTime'],
        limit: 1,
      })
      .then(results => {
        if (results.length > 0) {
          const recent = results[0]
          if (recent && recent.state === 'complete' && !resolved) {
            // Give it a moment to ensure it's our download
            setTimeout(() => {
              if (!resolved) {
                resolved = true
                chrome.downloads.onChanged.removeListener(listener as any)
                resolve()
              }
            }, 500)
          }
        }
      })

    setTimeout(() => {
      if (!resolved) {
        resolved = true
        chrome.downloads.onChanged.removeListener(listener as any)
        onTimeout?.()
        reject(new Error('Download timeout'))
      }
    }, timeout)
  })
}

/**
 * Navigate to a URL and discover wiki sub-pages
 */
export async function discoverWikiPages(url: string): Promise<string[]> {
  let tab: chrome.tabs.Tab | null = null

  try {
    tab = await chrome.tabs.create({ url, active: false })

    if (!tab.id) {
      return []
    }

    await waitForPageLoad(tab.id, 30000)

    const results = await chrome.scripting.executeScript({
      func: discoverWikiSubPagesFn,
      target: { tabId: tab.id },
    })

    return (results[0]?.result as string[]) || []
  } catch {
    return []
  } finally {
    if (tab?.id) {
      await chrome.tabs.remove(tab.id).catch(() => {})
    }
  }
}

/**
 * Function to be executed in MAIN world to discover wiki sub-pages
 */
function discoverWikiSubPagesFn(): string[] {
  const foundUrls = new Set<string>()

  // Wiki URL patterns
  const WIKI_PATTERNS = [
    /feishu\.cn\/wiki/,
    /feishu\.cn\/space\/[^/]+\/wiki/,
    /feishu\.net\/wiki/,
    /feishu\.net\/space\/[^/]+\/wiki/,
    /larksuite\.com\/wiki/,
    /larksuite\.com\/space\/[^/]+\/wiki/,
    /larkoffice\.com\/wiki/,
    /larkoffice\.com\/space\/[^/]+\/wiki/,
    /larkenterprise\.com\/wiki/,
    /larkenterprise\.com\/space\/[^/]+\/wiki/,
  ]

  function isWikiLink(href: string): boolean {
    if (!href) return false
    try {
      const url = new URL(href, window.location.origin)
      const pathname = url.pathname + url.search
      return WIKI_PATTERNS.some(pattern => {
        try {
          return new RegExp(pattern).test(pathname)
        } catch {
          return false
        }
      })
    } catch {
      return false
    }
  }

  // Look for wiki links in various selectors
  const selectors = [
    '[data-testid="wiki-toc"] a',
    '.wiki-toc a',
    '.wiki-sidebar a',
    '[data-testid="wiki-nav"] a',
    '.wiki-navigation a',
    'nav a[href*="/wiki/"]',
  ]

  selectors.forEach(selector => {
    document.querySelectorAll(selector).forEach((link: Element) => {
      const a = link as HTMLAnchorElement
      if (a.href && isWikiLink(a.href)) {
        const url = new URL(a.href, window.location.origin)
        url.hash = ''
        url.search = ''
        foundUrls.add(url.href)
      }
    })
  })

  // Also look for all wiki links
  document.querySelectorAll('a').forEach((link: Element) => {
    const a = link as HTMLAnchorElement
    if (a.href && isWikiLink(a.href)) {
      const url = new URL(a.href, window.location.origin)
      url.hash = ''
      url.search = ''
      foundUrls.add(url.href)
    }
  })

  return Array.from(foundUrls)
}
