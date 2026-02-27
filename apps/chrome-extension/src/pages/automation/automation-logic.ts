import { BatchManager, type DownloadJob } from '@/common/batch-manager'
import {
  isWikiPage,
  discoverWikiRecursively,
  type WikiPageInfo,
} from '@/common/wiki-detector'
import { downloadDocument } from '@/common/tab-automation'
import {
  generateMarkdownManifest,
  generateCSVManifest,
  generateFilename,
  type WikiManifest,
} from '@/common/wiki-manifest'
import { getSettings, SettingKey } from '@/common/settings'

export interface BatchDownloadOptions {
  urls: string[]
  recursiveWiki: boolean
  maxDepth: number // -1 for unlimited
  includeMainPage: boolean
  delay: number
  onProgress: (current: number, total: number) => void
  onLog: (level: 'info' | 'error' | 'success', message: string) => void
  onJobStatus: (jobId: string, status: string, title?: string) => void
}

export async function startBatchDownload(
  options: BatchDownloadOptions,
): Promise<void> {
  const {
    urls,
    recursiveWiki,
    maxDepth,
    includeMainPage,
    delay,
    onProgress,
    onLog,
    onJobStatus,
  } = options

  const allUrls = new Set<string>()
  const wikiPages: WikiPageInfo[] = [] // Track wiki pages for manifest
  const downloadedUrls = new Set<string>() // Track URLs already downloaded during discovery

  // Get settings for subfolder and nested folders preferences
  const settings = await getSettings([
    SettingKey.BatchDownloadSubfolder,
    SettingKey.BatchDownloadNestedFolders,
  ])
  const useSubfolder = settings[SettingKey.BatchDownloadSubfolder]
  const useNestedFolders = settings[SettingKey.BatchDownloadNestedFolders]

  // Check if we're doing a wiki batch download (will determine subfolder after first wiki discovery)
  let subfolder: string | null = null
  const generateSubfolderIfNeeded = () => {
    if (useSubfolder && !subfolder) {
      subfolder = generateSubfolderName()
      const folderInfo = useNestedFolders
        ? ' (with wiki structure hierarchy)'
        : ' (flat organization)'
      onLog(
        'info',
        `📁 Files will be organized in subfolder: ${subfolder}${folderInfo}`,
      )
    }
  }

  onLog('info', 'Processing URLs...')

  // Process each input URL
  for (const inputUrl of urls) {
    onLog('info', `Processing: ${inputUrl}`)

    // Normalize the input URL for comparison
    let normalizedInputUrl: string
    try {
      const parsed = new URL(inputUrl)
      parsed.hash = ''
      normalizedInputUrl = parsed.href
    } catch {
      normalizedInputUrl = inputUrl
    }

    if (isWikiPage(inputUrl) && recursiveWiki) {
      onLog('info', 'Detected wiki page, discovering sub-pages...')

      // Generate subfolder when first wiki is detected
      generateSubfolderIfNeeded()

      try {
        const discoveredPages = await discoverWikiRecursively(
          inputUrl,
          maxDepth === -1 ? Infinity : maxDepth,
          0,
          new Set(),
          {
            onProgress: (currentDepth, totalUrls) => {
              onLog(
                'info',
                `Discovery depth ${currentDepth}: found ${totalUrls} pages`,
              )
            },
            onPageDiscovered: async (page, tabId) => {
              // Download the page content during discovery!
              onLog(
                'info',
                `📥 Downloading during discovery: ${page.title || page.url}`,
              )

              // Pre-calculate filename with nested path if enabled
              const nestedFilename = useNestedFolders
                ? generateFilename(
                    page,
                    wikiPages.length,
                    useNestedFolders,
                    wikiPages,
                  )
                : null

              await downloadPageInTab(
                tabId,
                page,
                subfolder,
                nestedFilename,
                onLog,
              )
              downloadedUrls.add(page.url)
            },
          },
        )

        onLog(
          'info',
          `Found ${discoveredPages.length} pages (including main page)`,
        )

        // discoveredPages[0] is always the main page we started with
        // The rest are sub-pages
        if (includeMainPage) {
          // Include all pages (main + sub-pages)
          discoveredPages.forEach(p => {
            if (!downloadedUrls.has(p.url)) {
              allUrls.add(p.url)
              wikiPages.push(p)
            } else {
              // Already downloaded during discovery, just add to wiki pages list
              wikiPages.push(p)
            }
          })
          onLog(
            'info',
            `Including main page: downloading all ${discoveredPages.length} pages`,
          )
        } else {
          // Skip the main page (first element), only download sub-pages
          if (discoveredPages.length > 1) {
            discoveredPages.slice(1).forEach(p => {
              if (!downloadedUrls.has(p.url)) {
                allUrls.add(p.url)
                wikiPages.push(p)
              } else {
                wikiPages.push(p)
              }
            })
            onLog(
              'info',
              `Excluding main page: downloading ${discoveredPages.length - 1} sub-pages`,
            )
          } else {
            // Only found main page, no sub-pages
            onLog(
              'info',
              'No sub-pages found and main page excluded - skipping',
            )
          }
        }
      } catch (error) {
        onLog(
          'error',
          `Failed to discover wiki pages: ${error instanceof Error ? error.message : String(error)}`,
        )
        // Still add the original URL as fallback
        onLog('info', 'Adding original URL as fallback')
        allUrls.add(inputUrl)
      }
    } else {
      // Not a wiki or wiki discovery disabled, just add the URL
      onLog(
        'info',
        'Adding URL directly (wiki discovery disabled or not a wiki page)',
      )
      allUrls.add(inputUrl)
    }
  }

  const finalUrls = Array.from(allUrls)
  onLog('info', `Total URLs to download: ${finalUrls.length}`)
  onLog('info', `Already downloaded during discovery: ${downloadedUrls.size}`)

  if (finalUrls.length === 0) {
    onLog('success', 'All pages already downloaded during discovery!')
  }

  onLog('info', `Wiki pages collected: ${wikiPages.length}`)

  // Debug: log all wiki page titles
  if (wikiPages.length > 0) {
    console.log(
      '[Manifest] Wiki pages for manifest:',
      wikiPages.map(p => ({ title: p.title, url: p.url })),
    )
  }

  // Generate manifest if we have multiple wiki pages (including single page with sub-pages)
  if (wikiPages.length >= 1) {
    onLog('info', 'Generating wiki manifest files...')
    await generateAndDownloadManifest(
      wikiPages,
      urls[0] || '',
      subfolder,
      useNestedFolders,
      onLog,
    )
  } else {
    onLog('info', 'No wiki pages found for manifest generation')
  }

  // Only run batch download for URLs not yet downloaded
  const remainingUrls = finalUrls.filter(url => !downloadedUrls.has(url))
  if (remainingUrls.length > 0) {
    onLog('info', `Downloading remaining ${remainingUrls.length} pages...`)

    // Create batch manager
    const batchManager = new BatchManager({
      urls: remainingUrls,
      maxRetries: 3,
      delay,
      onProgress,
      onLog,
      onJobStart: job => {
        onJobStatus(job.id, 'downloading', job.title)
      },
      onJobComplete: job => {
        onJobStatus(job.id, 'completed', job.title)
      },
      onJobFailed: job => {
        onJobStatus(job.id, 'failed', job.title)
      },
    })

    // Process sequentially
    await batchManager.start(async (job: DownloadJob) => {
      const result = await downloadDocument(job.url, {
        timeout: 60000,
        onPageLoadTimeout: () => {
          onLog('error', `Page load timeout for ${job.url}`)
        },
        onDownloadTimeout: () => {
          onLog('error', `Download timeout for ${job.url}`)
        },
      })

      if (!result.success) {
        throw new Error(result.error || 'Download failed')
      }

      // Update job title if we got one
      if (result.title) {
        job.title = result.title
      }
    })
  }
}

/**
 * Download a page in an already-open tab (during wiki discovery)
 */
async function downloadPageInTab(
  tabId: number,
  page: WikiPageInfo,
  subfolder: string | null,
  nestedFilename: string | null,
  onLog: (level: 'info' | 'error' | 'success', message: string) => void,
): Promise<void> {
  try {
    // Store subfolder and nested filename in chrome.storage for the download script to read
    if (subfolder) {
      await chrome.storage.local.set({ __AUTOMATION_SUBFOLDER__: subfolder })
    } else {
      await chrome.storage.local.remove('__AUTOMATION_SUBFOLDER__')
    }

    // Store nested filename if provided (this is the full relative path including nested folders)
    if (nestedFilename) {
      await chrome.storage.local.set({
        __AUTOMATION_NESTED_FILENAME__: nestedFilename,
      })
    } else {
      await chrome.storage.local.remove('__AUTOMATION_NESTED_FILENAME__')
    }

    // Set automation flag
    await chrome.scripting.executeScript({
      func: () => {
        // @ts-expect-error - Automation mode flag
        window.__AUTOMATION_MODE__ = true
      },
      target: { tabId },
    })

    // Inject download script
    await chrome.scripting.executeScript({
      files: ['bundles/scripts/download-lark-docx-as-markdown.js'],
      target: { tabId },
      world: 'MAIN',
    })

    // Wait for download to complete (reuse the tracking logic)
    const startTime = Date.now()
    await waitForDownloadComplete(startTime, 30000)

    // Small delay to ensure file is written
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Close the tab
    await chrome.tabs.remove(tabId).catch(() => {})

    onLog('success', `✓ Downloaded: ${page.title || page.url}`)
  } catch (error) {
    onLog(
      'error',
      `✗ Failed to download ${page.url}: ${error instanceof Error ? error.message : String(error)}`,
    )
    // Close tab even if download failed
    await chrome.tabs.remove(tabId).catch(() => {})
    throw error
  }
}

/**
 * Wait for download to complete (simplified version for discovery phase)
 */
function waitForDownloadComplete(
  startTime: number,
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const CHECK_INTERVAL = 200
    const MAX_WAIT = 5000
    let elapsedTime = 0

    const checkForDownload = async () => {
      try {
        const results = await new Promise<chrome.downloads.DownloadItem[]>(
          resolve => {
            chrome.downloads.search(
              {
                orderBy: ['-startTime'],
                limit: 20,
              },
              result => resolve(result),
            )
          },
        )

        if (results) {
          const ourDownload = results.find(
            d =>
              d.startTime &&
              d.startTime >= startTime - 1000 &&
              d.startTime <= Date.now(),
          )

          if (ourDownload) {
            if (ourDownload.state === 'complete') {
              resolve()
              return
            } else if (ourDownload.error) {
              reject(new Error(`Download error: ${ourDownload.error}`))
              return
            }
          }
        }
      } catch (error) {
        // Ignore errors, try again
      }

      elapsedTime += CHECK_INTERVAL
      if (elapsedTime >= MAX_WAIT) {
        // Assume success after max wait
        resolve()
        return
      }

      setTimeout(checkForDownload, CHECK_INTERVAL)
    }

    // Start checking
    setTimeout(checkForDownload, 500)
  })
}

/**
 * Generate and download the manifest file
 */
async function generateAndDownloadManifest(
  pages: WikiPageInfo[],
  rootUrl: string,
  subfolder: string | null,
  useNestedFolders: boolean,
  onLog: (level: 'info' | 'error' | 'success', message: string) => void,
): Promise<void> {
  try {
    // Assign filenames to pages
    const pagesWithFilenames = pages.map((page, index) => ({
      ...page,
      downloadFilename: generateFilename(page, index, useNestedFolders, pages),
      index,
    }))

    // Create manifest
    const manifest: WikiManifest = {
      title: 'Wiki Export Manifest',
      rootUrl,
      totalFiles: pages.length,
      pages: pagesWithFilenames,
      generatedAt: new Date().toISOString(),
    }

    // Generate markdown manifest
    const markdownManifest = generateMarkdownManifest(manifest)

    // Also generate CSV manifest
    const csvManifest = generateCSVManifest(manifest)

    // Download both manifests
    const manifestBaseName = 'wiki-manifest'

    // Prepend subfolder path if specified
    const mdPath = subfolder
      ? `${subfolder}/${manifestBaseName}.md`
      : `${manifestBaseName}.md`
    const csvPath = subfolder
      ? `${subfolder}/${manifestBaseName}.csv`
      : `${manifestBaseName}.csv`

    // Download markdown manifest
    await downloadManifestFile(mdPath, markdownManifest, 'text/markdown', onLog)

    // Download CSV manifest
    await downloadManifestFile(csvPath, csvManifest, 'text/csv', onLog)

    onLog(
      'success',
      `✓ Generated manifest files: ${manifestBaseName}.md and ${manifestBaseName}.csv`,
    )
  } catch (error) {
    onLog(
      'error',
      `Failed to generate manifest: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Download a manifest file using Chrome Downloads API
 */
async function downloadManifestFile(
  filename: string,
  content: string,
  mimeType: string,
  onLog: (level: 'info' | 'error' | 'success', message: string) => void,
): Promise<void> {
  try {
    onLog('info', `Creating manifest file: ${filename}`)

    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` })
    const reader = new FileReader()

    await new Promise<void>((resolve, reject) => {
      reader.onloadend = () => {
        const dataUrl = reader.result as string

        console.log(
          `[Manifest] Starting download: ${filename}, MIME: ${mimeType}, size: ${dataUrl.length} chars`,
        )

        chrome.downloads.download(
          {
            url: dataUrl,
            filename,
            saveAs: false,
            conflictAction: 'uniquify',
          },
          downloadId => {
            if (chrome.runtime.lastError) {
              console.error(
                '[Manifest] Download failed:',
                chrome.runtime.lastError,
              )
              reject(new Error(chrome.runtime.lastError.message))
            } else if (downloadId) {
              console.log(
                `[Manifest] Download started: ${filename}, ID: ${downloadId}`,
              )
              resolve()
            } else {
              console.error(
                '[Manifest] Download failed: No download ID returned',
              )
              reject(new Error('Failed to download manifest'))
            }
          },
        )
      }

      reader.onerror = () => {
        console.error('[Manifest] FileReader error:', reader.error)
        reject(reader.error)
      }

      reader.readAsDataURL(blob)
    })

    // Wait a moment for download to start
    await new Promise(resolve => setTimeout(resolve, 500))

    onLog('success', `✓ Downloaded: ${filename}`)
  } catch (error) {
    onLog(
      'error',
      `✗ Failed to download ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}

/**
 * Generate a subfolder name for batch downloads
 * Format: wiki-export-{YYYY-MM-DD-HHMMSS}
 */
function generateSubfolderName(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')

  return `wiki-export-${year}-${month}-${day}-${hours}${minutes}${seconds}`
}
