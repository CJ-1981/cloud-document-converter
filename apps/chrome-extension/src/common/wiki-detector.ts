// URL patterns for wiki detection
// These match the pathname part (after the domain)
const WIKI_PATTERNS = [
  /\/wiki\//,           // Matches /wiki/ anywhere in path
  /\/space\/[^/]+\/wiki\//, // Matches /space/{id}/wiki/
]

/**
 * Check if a URL is a Lark wiki page
 */
export function isWikiPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    const testString = parsedUrl.pathname + parsedUrl.search
    const result = WIKI_PATTERNS.some(pattern => pattern.test(testString))

    if (!result) {
      console.log('[isWikiPage] Not matched:', {
        url,
        testString,
        patterns: WIKI_PATTERNS,
      })
    } else {
      console.log('[isWikiPage] Matched:', { url })
    }

    return result
  } catch (error) {
    console.error('[isWikiPage] Error:', error)
    return false
  }
}

/**
 * Extract wiki page links from the current page (executed in MAIN world)
 * This function should be serialized and executed via executeScript
 */
export function discoverWikiSubPagesCode(): string {
  return `
    (function() {
      const foundUrls = new Set();
      const currentUrl = window.location.href;
      const currentUrlObj = new URL(currentUrl);
      const currentUrlWithoutHash = currentUrlObj.origin + currentUrlObj.pathname;

      // Helper to check if a link is a wiki link (but not the current page)
      function isWikiLink(href) {
        if (!href || href === currentUrl || href.startsWith('#')) return false;
        try {
          const url = new URL(href, window.location.origin);
          const pathname = url.pathname + url.search;
          // Simply check if it contains /wiki/
          const isWiki = pathname.includes('/wiki/') || pathname.includes('/wiki?');

          // Exclude the current page
          const urlWithoutHash = url.origin + url.pathname;
          if (urlWithoutHash === currentUrlWithoutHash) return false;

          return isWiki;
        } catch {
          return false;
        }
      }

      // Method 1: Look for wiki table of contents and sidebar
      const tocSelectors = [
        '[data-testid="wiki-toc"] a',
        '.wiki-toc a',
        '.wiki-sidebar a',
        '[data-testid="wiki-nav"] a',
        '.wiki-navigation a',
        'nav a[href*="/wiki/"]',
        // Lark-specific selectors
        '.wiki-catalog-tree-node-title a',
        '.wiki-tree-item a',
        '[class*="wiki"] a[href*="wiki"]',
        'a[href*="/wiki/"]',
      ];

      tocSelectors.forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach(link => {
            const href = link.getAttribute('href');
            if (href && isWikiLink(href)) {
              const url = new URL(href, window.location.origin);
              url.hash = '';
              url.search = '';
              foundUrls.add(url.href);
            }
          });
        } catch (e) {
          // Ignore selector errors
        }
      });

      // Method 2: Look for all links on the page that point to wiki pages
      document.querySelectorAll('a').forEach(link => {
        const href = link.getAttribute('href');
        if (href && isWikiLink(href)) {
          const url = new URL(href, window.location.origin);
          url.hash = '';
          url.search = '';
          foundUrls.add(url.href);
        }
      });

      // Method 3: Look for any links containing wiki patterns
      const allLinks = Array.from(document.querySelectorAll('a'));
      allLinks.forEach(link => {
        const textContent = link.textContent?.trim();
        const href = link.getAttribute('href');

        // Only add if it looks like a page link (has text content)
        if (href && textContent && textContent.length > 0 && textContent.length < 200) {
          if (href.includes('/wiki/') || href.includes('wiki')) {
            try {
              const url = new URL(href, window.location.origin);
              url.hash = '';
              url.search = '';
              // Don't add the current page
              if (url.href !== currentUrl) {
                foundUrls.add(url.href);
              }
            } catch (e) {
              // Invalid URL, skip
            }
          }
        }
      });

      // Method 4: Look for data attributes that might contain page info
      const pageElements = document.querySelectorAll('[data-page-id], [data-token], [data-url]');
      pageElements.forEach(el => {
        const href = el.getAttribute('href') || el.getAttribute('data-url');
        if (href && isWikiLink(href)) {
          try {
            const url = new URL(href, window.location.origin);
            url.hash = '';
            url.search = '';
            if (url.href !== currentUrl) {
              foundUrls.add(url.href);
            }
          } catch (e) {
            // Invalid URL, skip
          }
        }
      });

      console.log('[Wiki Discovery] Found URLs:', Array.from(foundUrls));
      console.log('[Wiki Discovery] Total count:', foundUrls.size);

      // Convert Set to Array and return
      return Array.from(foundUrls);
    })();
  `
}

export interface WikiPageInfo {
  url: string
  title?: string
  depth: number
  parentUrl?: string
}

export interface WikiDiscoveryOptions {
  maxDepth?: number
  onProgress?: (currentDepth: number, totalUrls: number) => void
}

/**
 * Discover wiki sub-pages recursively with page info
 */
export async function discoverWikiRecursively(
  url: string,
  maxDepth: number = Infinity,
  currentDepth: number = 0,
  visited: Set<string> = new Set(),
  options: WikiDiscoveryOptions = {},
  parentUrl?: string
): Promise<WikiPageInfo[]> {
  // Normalize URL for deduplication
  let normalizedUrl: string
  try {
    const parsedUrl = new URL(url)
    parsedUrl.hash = ''
    normalizedUrl = parsedUrl.href
  } catch {
    return []
  }

  // Check depth and visited
  if (currentDepth >= maxDepth || visited.has(normalizedUrl)) {
    return []
  }

  visited.add(normalizedUrl)

  // Create a tab to discover sub-pages
  const tab = await chrome.tabs.create({ url: normalizedUrl, active: false })

  try {
    // Wait for page to load
    await waitForPageLoad(tab.id!)

    // Get the page title
    const titleResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: () => {
        // Try to get title from Lark's global state
        // @ts-expect-error - Lark global
        if (window.PageMain?.blockManager?.rootBlockModel?.title) {
          // @ts-expect-error - Lark global
          return window.PageMain.blockManager.rootBlockModel.title
        }
        return document.title
      },
    })

    const pageTitle = titleResults[0]?.result as string | undefined

    // Execute script to discover sub-pages
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: discoverWikiSubPagesFn,
    })

    const subPages = (results[0]?.result as string[]) || []

    console.log(`[Wiki Discovery] Depth ${currentDepth}: Found ${subPages.length} sub-pages from ${normalizedUrl}`)

    // Create page info for current page
    const currentPageInfo: WikiPageInfo = {
      url: normalizedUrl,
      title: pageTitle,
      depth: currentDepth,
      parentUrl: parentUrl,
    }

    // Filter out the current page and already visited URLs
    const newSubPages = subPages.filter(u => {
      const parsed = new URL(u)
      parsed.hash = ''
      const normalized = parsed.href
      return normalized !== normalizedUrl && !visited.has(normalized)
    })

    options.onProgress?.(currentDepth, visited.size)

    // Recursively discover nested sub-pages (with depth limit to prevent infinite loops)
    const allPages: WikiPageInfo[] = [currentPageInfo]

    // Limit recursion depth to prevent issues
    const MAX_SUB_PAGES_PER_LEVEL = 50
    const limitedSubPages = newSubPages.slice(0, MAX_SUB_PAGES_PER_LEVEL)

    for (const subPage of limitedSubPages) {
      // Only recurse if depth allows and we haven't visited too many pages
      if (currentDepth + 1 < maxDepth && visited.size < 200) {
        const nested = await discoverWikiRecursively(
          subPage,
          maxDepth,
          currentDepth + 1,
          visited,
          options,
          normalizedUrl // Current page is the parent
        )
        allPages.push(...nested)
      } else {
        // Just add the sub-page without recursing
        allPages.push({
          url: subPage,
          depth: currentDepth + 1,
          parentUrl: normalizedUrl,
        })
      }
    }

    return allPages
  } finally {
    await chrome.tabs.remove(tab.id!)
  }
}

/**
 * Wait for a page to complete loading
 */
function waitForPageLoad(tabId: number, timeout: number = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false

    const listener = (tabId_: number, changeInfo: any) => {
      if (!resolved && tabId_ === tabId && changeInfo.status === 'complete') {
        resolved = true
        chrome.tabs.onUpdated.removeListener(listener as any)
        // Wait a bit for dynamic content to load
        setTimeout(resolve, 2000)
      }
    }

    chrome.tabs.onUpdated.addListener(listener as any)

    // Check if already complete
    chrome.tabs.get(tabId).then((tab) => {
      if (!resolved && tab.status === 'complete') {
        resolved = true
        chrome.tabs.onUpdated.removeListener(listener as any)
        // Wait a bit for dynamic content to load
        setTimeout(resolve, 2000)
      }
    }).catch((error) => {
      if (!resolved) {
        resolved = true
        chrome.tabs.onUpdated.removeListener(listener as any)
        reject(error)
      }
    })

    setTimeout(() => {
      if (!resolved) {
        resolved = true
        chrome.tabs.onUpdated.removeListener(listener as any)
        // Resolve anyway after timeout (page might be usable)
        resolve()
      }
    }, timeout)
  })
}

/**
 * Function to be executed in MAIN world to discover wiki sub-pages
 */
function discoverWikiSubPagesFn(): string[] {
  const foundUrls = new Set<string>()
  const currentUrl = window.location.href
  const currentUrlObj = new URL(currentUrl)
  const currentUrlWithoutHash = currentUrlObj.origin + currentUrlObj.pathname

  // Wiki patterns (same as above but recreated for MAIN world)
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
    if (!href || href === currentUrl || href.startsWith('#')) return false
    try {
      const url = new URL(href, window.location.origin)
      const pathname = url.pathname + url.search
      // Simply check if it contains /wiki/
      const isWiki = pathname.includes('/wiki/') || pathname.includes('/wiki?')

      const urlWithoutHash = url.origin + url.pathname
      if (urlWithoutHash === currentUrlWithoutHash) return false

      return isWiki
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
    '.wiki-catalog-tree-node-title a',
    '.wiki-tree-item a',
    '[class*="wiki"] a[href*="wiki"]',
  ]

  selectors.forEach(selector => {
    try {
      document.querySelectorAll(selector).forEach((link: Element) => {
        const a = link as HTMLAnchorElement
        const href = a.getAttribute('href')
        if (href && isWikiLink(href)) {
          const url = new URL(href, window.location.origin)
          url.hash = ''
          url.search = ''
          if (url.href !== currentUrl) {
            foundUrls.add(url.href)
          }
        }
      })
    } catch (e) {
      // Ignore selector errors
    }
  })

  // Also look for all wiki links on the page
  document.querySelectorAll('a').forEach((link: Element) => {
    const a = link as HTMLAnchorElement
    const href = a.getAttribute('href')
    const textContent = a.textContent?.trim()

    if (href && textContent && textContent.length > 0 && textContent.length < 200) {
      if (isWikiLink(href)) {
        try {
          const url = new URL(href, window.location.origin)
          url.hash = ''
          url.search = ''
          if (url.href !== currentUrl) {
            foundUrls.add(url.href)
          }
        } catch (e) {
          // Invalid URL, skip
        }
      }
    }
  })

  return Array.from(foundUrls)
}
