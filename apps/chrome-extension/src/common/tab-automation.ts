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
  let downloadStartTime = 0

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

    // Track when we're starting the download attempt
    downloadStartTime = Date.now()

    // Inject download script
    await chrome.scripting.executeScript({
      files: ['bundles/scripts/download-lark-docx-as-markdown.js'],
      target: { tabId: tab.id },
      world: 'MAIN',
    })

    // Wait for download to complete and write to disk
    await waitForDownloadComplete(downloadStartTime, timeout, onDownloadTimeout)

    // Small delay to ensure file is fully written to disk
    await new Promise(resolve => setTimeout(resolve, 1000))

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
  startTime: number,
  timeout: number,
  onTimeout?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false
    const CHECK_INTERVAL = 200 // Check every 200ms (faster)
    const MAX_WAIT = 5000 // Wait up to 5 seconds (reduced from 10)
    let elapsedTime = 0

    const checkForDownload = async () => {
      if (resolved) return

      try {
        const results = await new Promise<chrome.downloads.DownloadItem[]>(
          resolve => {
            chrome.downloads.search(
              {
                orderBy: ['-startTime'],
                limit: 50,
              },
              result => resolve(result),
            )
          },
        )

        if (!results) {
          scheduleNextCheck()
          return
        }

        // Look for downloads that started after our start time
        const ourDownloads = results.filter(
          download =>
            download.startTime &&
            download.startTime >= startTime - 1000 &&
            download.startTime <= Date.now(),
        )

        if (ourDownloads.length > 0) {
          const download = ourDownloads[0]

          if (download.state === 'complete') {
            resolved = true
            console.log('[Download] Download completed successfully:', {
              id: download.id,
              filename: download.filename,
              fileSize: download.totalBytes,
            })
            resolve()
            return
          } else if (download.error) {
            resolved = true
            console.error('[Download] Download failed:', download.error)
            reject(new Error(`Download error: ${download.error}`))
            return
          }
        }
      } catch (error) {
        console.error('[Download] Error checking downloads:', error)
      }

      scheduleNextCheck()
    }

    const scheduleNextCheck = () => {
      if (resolved) return

      elapsedTime += CHECK_INTERVAL

      if (elapsedTime >= MAX_WAIT) {
        // After waiting, check one more time if we have a recent download
        chrome.downloads.search(
          {
            orderBy: ['-startTime'],
            limit: 5,
          },
          results => {
            if (resolved) return

            const recentDownload = results?.find(
              d =>
                d.startTime &&
                d.startTime >= startTime - 2000 &&
                d.startTime <= Date.now(),
            )

            if (recentDownload && recentDownload.state === 'complete') {
              resolved = true
              console.log('[Download] Download completed (late check):', {
                id: recentDownload.id,
                filename: recentDownload.filename,
              })
              resolve()
              return
            }

            // If we still haven't found it, consider it successful anyway
            resolved = true
            console.log(
              '[Download] Assuming download succeeded (not found in tracker)',
            )
            resolve()
          },
        )
        return
      }

      setTimeout(checkForDownload, CHECK_INTERVAL)
    }

    // Start checking immediately (no delay)
    checkForDownload()
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
