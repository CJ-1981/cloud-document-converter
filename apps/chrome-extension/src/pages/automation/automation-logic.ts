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
  for (const url of urls) {
    onLog('info', `Processing: ${url}`)

    if (isWikiPage(url) && recursiveWiki) {
      onLog('info', 'Detected wiki page, discovering sub-pages...')

      try {
        const wikiUrls = await discoverWikiRecursively(
          url,
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

        onLog('info', `Found ${wikiUrls.length} pages (including sub-pages)`)

        if (includeMainPage) {
          wikiUrls.forEach(u => allUrls.add(u))
        } else {
          // Skip the first URL (main page) if not including
          wikiUrls.slice(1).forEach(u => allUrls.add(u))
        }
      } catch (error) {
        onLog(
          'error',
          `Failed to discover wiki pages: ${error instanceof Error ? error.message : String(error)}`,
        )
        // Still add the original URL as fallback
        allUrls.add(url)
      }
    } else {
      allUrls.add(url)
    }
  }

  onLog('info', `Total URLs to download: ${allUrls.size}`)

  // Create batch manager
  const batchManager = new BatchManager({
    urls: Array.from(allUrls),
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
