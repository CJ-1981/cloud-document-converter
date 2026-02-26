export interface DownloadJob {
  id: string
  url: string
  title?: string
  status: 'pending' | 'downloading' | 'completed' | 'failed'
  error?: string
  attempt: number
}

export interface BatchOptions {
  urls: string[]
  maxRetries?: number
  delay?: number // milliseconds between downloads
  onProgress?: (completed: number, total: number) => void
  onLog?: (level: 'info' | 'error' | 'success', message: string) => void
  onJobStart?: (job: DownloadJob) => void
  onJobComplete?: (job: DownloadJob) => void
  onJobFailed?: (job: DownloadJob) => void
}

export class BatchManager {
  private jobs: DownloadJob[] = []
  private options: Required<Omit<BatchOptions, 'urls'>>
  private completedCount = 0
  private isPaused = false
  private isStopped = false
  private currentJobId: string | null = null

  constructor(options: BatchOptions) {
    this.options = {
      maxRetries: 3,
      delay: 1000,
      onProgress: () => {},
      onLog: () => {},
      onJobStart: () => {},
      onJobComplete: () => {},
      onJobFailed: () => {},
      ...options,
    }

    // Create jobs from URLs
    this.jobs = options.urls.map((url, index) => ({
      id: `job-${index}-${Date.now()}`,
      url,
      status: 'pending' as const,
      attempt: 0,
    }))
  }

  getJobs(): DownloadJob[] {
    return [...this.jobs]
  }

  getPendingJobs(): DownloadJob[] {
    return this.jobs.filter(job => job.status === 'pending')
  }

  getCompletedJobs(): DownloadJob[] {
    return this.jobs.filter(job => job.status === 'completed')
  }

  getFailedJobs(): DownloadJob[] {
    return this.jobs.filter(job => job.status === 'failed')
  }

  pause(): void {
    this.isPaused = true
    this.options.onLog('info', 'Batch paused')
  }

  resume(): void {
    this.isPaused = false
    this.options.onLog('info', 'Batch resumed')
  }

  stop(): void {
    this.isStopped = true
    this.options.onLog('info', 'Batch stopped')
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private async processJob(
    job: DownloadJob,
    executor: (job: DownloadJob) => Promise<void>,
  ): Promise<void> {
    if (this.isStopped) {
      return
    }

    while (this.isPaused) {
      await this.delay(100)
    }

    if (this.isStopped) {
      return
    }

    job.status = 'downloading'
    job.attempt++
    this.currentJobId = job.id
    this.options.onJobStart(job)

    try {
      await executor(job)
      job.status = 'completed'
      this.completedCount++
      this.options.onJobComplete(job)
      this.options.onProgress(this.completedCount, this.jobs.length)
      this.options.onLog('success', `✓ ${job.title || job.url}`)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      if (job.attempt < this.options.maxRetries) {
        this.options.onLog(
          'info',
          `Retrying ${job.url} (attempt ${job.attempt + 1}/${this.options.maxRetries})`,
        )
        job.status = 'pending'
        await this.delay(this.options.delay * job.attempt)
        await this.processJob(job, executor)
      } else {
        job.status = 'failed'
        job.error = errorMessage
        this.options.onJobFailed(job)
        this.options.onLog(
          'error',
          `✗ Failed: ${job.title || job.url} - ${errorMessage}`,
        )
      }
    } finally {
      this.currentJobId = null
    }
  }

  async start(executor: (job: DownloadJob) => Promise<void>): Promise<void> {
    this.isStopped = false
    this.isPaused = false
    this.completedCount = 0

    this.options.onLog(
      'info',
      `Starting batch download of ${this.jobs.length} URLs`,
    )

    for (const job of this.jobs) {
      if (this.isStopped) {
        break
      }

      if (job.status !== 'completed') {
        await this.processJob(job, executor)

        // Add delay between downloads (except for the last one)
        if (!this.isStopped && job !== this.jobs[this.jobs.length - 1]) {
          await this.delay(this.options.delay)
        }
      }
    }

    const completed = this.getCompletedJobs().length
    const failed = this.getFailedJobs().length

    this.options.onLog(
      'info',
      `Batch completed: ${completed} succeeded, ${failed} failed`,
    )
  }

  isRunning(): boolean {
    return this.currentJobId !== null
  }
}
