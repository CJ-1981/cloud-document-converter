// URL patterns for wiki detection
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

/**
 * Check if a URL is a Lark wiki page
 */
export function isWikiPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return WIKI_PATTERNS.some(pattern =>
      pattern.test(parsedUrl.pathname + parsedUrl.search),
    )
  } catch {
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

      // Helper to check if a link is a wiki link
      function isWikiLink(href) {
        if (!href) return false;
        try {
          const url = new URL(href, window.location.origin);
          const pathname = url.pathname + url.search;
          return ${WIKI_PATTERNS.map(p => p.toString()).join(' || ')}.some(pattern => {
            try {
              return new RegExp(pattern).test(pathname);
            } catch {
              return false;
            }
          });
        } catch {
          return false;
        }
      }

      // Method 1: Look for wiki table of contents
      const tocSelectors = [
        '[data-testid="wiki-toc"] a',
        '.wiki-toc a',
        '.wiki-sidebar a',
        '[data-testid="wiki-nav"] a',
        '.wiki-navigation a',
        'nav a[href*="/wiki/"]',
      ];

      tocSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(link => {
          if (link.href && isWikiLink(link.href)) {
            const url = new URL(link.href, window.location.origin);
            // Remove fragments and search params for deduplication
            url.hash = '';
            url.search = '';
            foundUrls.add(url.href);
          }
        });
      });

      // Method 2: Look for all wiki links on the page
      document.querySelectorAll('a').forEach(link => {
        if (link.href && isWikiLink(link.href)) {
          const url = new URL(link.href, window.location.origin);
          url.hash = '';
          url.search = '';
          foundUrls.add(url.href);
        }
      });

      // Convert Set to Array and return
      return Array.from(foundUrls);
    })();
  `
}

export interface WikiDiscoveryOptions {
  maxDepth?: number
  onProgress?: (currentDepth: number, totalUrls: number) => void
}

/**
 * Discover wiki sub-pages recursively
 */
export async function discoverWikiRecursively(
  url: string,
  maxDepth: number = Infinity,
  currentDepth: number = 0,
  visited: Set<string> = new Set(),
  options: WikiDiscoveryOptions = {},
): Promise<string[]> {
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

    // Execute script to discover sub-pages
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: discoverWikiSubPagesFn,
    })

    const subPages = (results[0]?.result as string[]) || []

    // Filter out already visited URLs
    const newSubPages = subPages.filter(u => !visited.has(u))

    options.onProgress?.(currentDepth, visited.size)

    // Recursively discover nested sub-pages
    const allUrls: string[] = [normalizedUrl]

    for (const subPage of newSubPages) {
      const nested = await discoverWikiRecursively(
        subPage,
        maxDepth,
        currentDepth + 1,
        visited,
        options,
      )
      allUrls.push(...nested)
    }

    return Array.from(new Set(allUrls))
  } finally {
    await chrome.tabs.remove(tab.id!)
  }
}

/**
 * Wait for a page to complete loading
 */
function waitForPageLoad(
  tabId: number,
  timeout: number = 30000,
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

    setTimeout(() => {
      if (!resolved) {
        resolved = true
        chrome.tabs.onUpdated.removeListener(listener as any)
        reject(new Error('Page load timeout'))
      }
    }, timeout)
  })
}

/**
 * Function to be executed in MAIN world to discover wiki sub-pages
 */
function discoverWikiSubPagesFn(): string[] {
  const foundUrls = new Set<string>()

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

  // Helper to check if a link is a wiki link
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
  const tocSelectors = [
    '[data-testid="wiki-toc"] a',
    '.wiki-toc a',
    '.wiki-sidebar a',
    '[data-testid="wiki-nav"] a',
    '.wiki-navigation a',
    'nav a[href*="/wiki/"]',
  ]

  tocSelectors.forEach(selector => {
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

  // Look for all wiki links on the page
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
