import { BatchManager, type DownloadJob } from '@/common/batch-manager'
import { isWikiPage, discoverWikiRecursively } from '@/common/wiki-detector'
import { downloadDocument } from '@/common/tab-automation'

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

      try {
        const wikiUrls = await discoverWikiRecursively(
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
          },
        )

        onLog('info', `Found ${wikiUrls.length} pages (including main page)`)

        // wikiUrls[0] is always the main page we started with
        // The rest are sub-pages
        if (includeMainPage) {
          // Include all pages (main + sub-pages)
          wikiUrls.forEach(u => allUrls.add(u))
          onLog('info', `Including main page: downloading all ${wikiUrls.length} pages`)
        } else {
          // Skip the main page (first element), only download sub-pages
          if (wikiUrls.length > 1) {
            wikiUrls.slice(1).forEach(u => allUrls.add(u))
            onLog('info', `Excluding main page: downloading ${wikiUrls.length - 1} sub-pages`)
          } else {
            // Only found main page, no sub-pages
            // Since user excluded main page, add nothing
            onLog('info', 'No sub-pages found and main page excluded - skipping')
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
      onLog('info', 'Adding URL directly (wiki discovery disabled or not a wiki page)')
      allUrls.add(inputUrl)
    }
  }

  const finalUrls = Array.from(allUrls)
  onLog('info', `Total URLs to download: ${finalUrls.length}`)

  if (finalUrls.length === 0) {
    onLog('error', 'No URLs to download!')
    return
  }

  // Create batch manager
  const batchManager = new BatchManager({
    urls: finalUrls,
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
