<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import {
  Play,
  Pause,
  Square,
  Upload,
  FileText,
  Trash2,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  FolderOpen,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { useInitLocale } from '../shared/i18n'
import { useInitTheme } from '../shared/theme'
import {
  startBatchDownload,
  type BatchDownloadOptions,
} from './automation-logic'

const { t } = useInitLocale()
useInitTheme()

// State
const urlInput = ref('')
const fileInput = ref<File | null>(null)
const isProcessing = ref(false)
const isPaused = ref(false)
const logs = ref<
  Array<{
    level: 'info' | 'error' | 'success'
    message: string
    timestamp: Date
  }>
>([])
const progress = ref({ current: 0, total: 0 })

// Options
const recursiveWiki = ref(true)
const maxDepth = ref<number>(-1) // -1 for unlimited
const includeMainPage = ref(true)
const delayBetweenDownloads = ref(1000)

// UI State
const showAdvancedOptions = ref(false)
const showLogs = ref(true)

// Computed
const progressPercentage = computed(() => {
  if (progress.value.total === 0) return 0
  return Math.round((progress.value.current / progress.value.total) * 100)
})

const canStart = computed(() => {
  return !isProcessing.value && urlInput.value.trim().length > 0
})

const canPause = computed(() => {
  return isProcessing.value && !isPaused.value
})

const canResume = computed(() => {
  return isProcessing.value && isPaused.value
})

const canStop = computed(() => {
  return isProcessing.value
})

// Methods
function addLog(level: 'info' | 'error' | 'success', message: string) {
  logs.value.push({ level, message, timestamp: new Date() })
  // Auto-scroll to bottom
  setTimeout(() => {
    const logContainer = document.getElementById('log-container')
    if (logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight
    }
  }, 10)
}

function handleFileUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) {
    fileInput.value = file
    const reader = new FileReader()
    reader.onload = e => {
      const content = e.target?.result as string
      // Parse URLs from file (one per line)
      const urls = content
        .split('\n')
        .map(line => line.trim())
        .filter(
          line =>
            line.length > 0 &&
            (line.startsWith('http://') || line.startsWith('https://')),
        )

      if (urlInput.value.trim()) {
        urlInput.value += '\n' + urls.join('\n')
      } else {
        urlInput.value = urls.join('\n')
      }

      addLog('info', `Loaded ${urls.length} URLs from ${file.name}`)
    }
    reader.readAsText(file)
  }
}

function clearUrls() {
  urlInput.value = ''
  fileInput.value = null
  addLog('info', 'URLs cleared')
}

function clearLogs() {
  logs.value = []
}

function openDownloadsFolder() {
  // Open Chrome's downloads page
  if (import.meta.env.DEV) {
    window.open('chrome://downloads', '_blank')
  } else {
    chrome.tabs.create({ url: 'chrome://downloads' })
  }
}

async function handleStart() {
  if (!canStart.value) return

  const urls = urlInput.value
    .split('\n')
    .map(line => line.trim())
    .filter(
      line =>
        line.length > 0 &&
        (line.startsWith('http://') || line.startsWith('https://')),
    )

  if (urls.length === 0) {
    addLog('error', 'No valid URLs found')
    return
  }

  logs.value = []
  progress.value = { current: 0, total: 0 }

  const batchOptions: BatchDownloadOptions = {
    urls,
    recursiveWiki: recursiveWiki.value,
    maxDepth: maxDepth.value,
    includeMainPage: includeMainPage.value,
    delay: delayBetweenDownloads.value,
    onProgress: (current, total) => {
      progress.value = { current, total }
    },
    onLog: (level, message) => {
      addLog(level, message)
    },
    onJobStatus: () => {}, // Not used in current implementation
  }

  isProcessing.value = true
  isPaused.value = false

  try {
    await startBatchDownload(batchOptions)
    addLog('success', 'Batch download completed!')
  } catch (error) {
    addLog(
      'error',
      `Batch download failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    isProcessing.value = false
    isPaused.value = false
  }
}

function handlePause() {
  isPaused.value = true
  addLog('info', 'Pausing...')
}

function handleResume() {
  isPaused.value = false
  addLog('info', 'Resuming...')
}

function handleStop() {
  isProcessing.value = false
  isPaused.value = false
  addLog('info', 'Stopping...')
}

// Cleanup on unmount
onUnmounted(() => {
  if (isProcessing.value) {
    handleStop()
  }
})
</script>

<template>
  <div class="min-h-screen bg-background p-6">
    <div class="mx-auto max-w-4xl space-y-6">
      <!-- Header -->
      <div class="space-y-2">
        <h1 class="text-3xl font-bold tracking-tight">
          Batch Download Automation
        </h1>
        <p class="text-muted-foreground">
          Automatically download multiple Lark documents
        </p>
      </div>

      <!-- URL Input Card -->
      <div class="rounded-lg border bg-card p-6 shadow-sm">
        <h2 class="flex items-center gap-2 text-lg font-semibold mb-2">
          <FileText class="h-5 w-5" />
          Document URLs
        </h2>
        <p class="text-sm text-muted-foreground mb-4">
          Enter one URL per line or upload a file (.txt or .csv)
        </p>

        <div class="flex gap-2 mb-4">
          <Button variant="outline" as="button">
            <label class="cursor-pointer flex items-center">
              <Upload class="mr-2 h-4 w-4" />
              Upload File
              <input
                type="file"
                accept=".txt,.csv"
                class="hidden"
                :disabled="isProcessing"
                @change="handleFileUpload"
              />
            </label>
          </Button>
          <Button
            variant="outline"
            :disabled="!urlInput.trim() || isProcessing"
            @click="clearUrls"
          >
            <Trash2 class="mr-2 h-4 w-4" />
            Clear
          </Button>
        </div>

        <textarea
          v-model="urlInput"
          placeholder="https://feishu.cn/docx/...
https://feishu.cn/wiki/..."
          class="flex min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="isProcessing"
        />

        <div class="text-sm text-muted-foreground mt-2">
          {{
            urlInput
              .split('\n')
              .map(line => line.trim())
              .filter(
                line =>
                  line.length > 0 &&
                  (line.startsWith('http://') || line.startsWith('https://')),
              ).length
          }}
          URLs
        </div>
      </div>

      <!-- Options Card -->
      <div class="rounded-lg border bg-card p-6 shadow-sm">
        <button
          class="flex items-center gap-2 w-full text-left font-semibold mb-2"
          @click="showAdvancedOptions = !showAdvancedOptions"
        >
          Options
          <ChevronDown v-if="!showAdvancedOptions" class="h-4 w-4" />
          <ChevronUp v-else class="h-4 w-4" />
        </button>

        <div v-if="showAdvancedOptions" class="space-y-4">
          <div class="space-y-2">
            <label class="flex items-center space-x-2 cursor-pointer">
              <input
                v-model="recursiveWiki"
                type="checkbox"
                class="h-4 w-4 rounded border-input"
                :disabled="isProcessing"
              />
              <span class="text-sm">Recursive Wiki Discovery</span>
            </label>
            <p class="text-sm text-muted-foreground pl-6">
              Automatically discover and download all wiki sub-pages
            </p>
          </div>

          <div class="space-y-2">
            <label class="flex items-center space-x-2 cursor-pointer">
              <input
                v-model="includeMainPage"
                type="checkbox"
                class="h-4 w-4 rounded border-input"
                :disabled="isProcessing"
              />
              <span class="text-sm">Include Wiki Main Page</span>
            </label>
          </div>

          <div class="space-y-2">
            <label class="text-sm">Delay Between Downloads (ms)</label>
            <input
              v-model.number="delayBetweenDownloads"
              type="number"
              min="0"
              step="100"
              class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              :disabled="isProcessing"
            />
          </div>
        </div>
      </div>

      <!-- Control Buttons -->
      <div class="flex gap-2">
        <Button :disabled="!canStart" @click="handleStart">
          <Play v-if="!isProcessing" class="mr-2 h-4 w-4" />
          <Loader2 v-else class="mr-2 h-4 w-4 animate-spin" />
          {{ isProcessing ? 'Processing...' : 'Start' }}
        </Button>

        <Button variant="outline" :disabled="!canPause" @click="handlePause">
          <Pause class="mr-2 h-4 w-4" />
          Pause
        </Button>

        <Button variant="outline" :disabled="!canResume" @click="handleResume">
          <Play class="mr-2 h-4 w-4" />
          Resume
        </Button>

        <Button variant="destructive" :disabled="!canStop" @click="handleStop">
          <Square class="mr-2 h-4 w-4" />
          Stop
        </Button>

        <Button variant="outline" @click="openDownloadsFolder">
          <FolderOpen class="mr-2 h-4 w-4" />
          Open Downloads
        </Button>
      </div>

      <!-- Progress Card -->
      <div
        v-if="isProcessing || logs.length > 0"
        class="rounded-lg border bg-card p-6 shadow-sm"
      >
        <h2
          class="flex items-center justify-between text-lg font-semibold mb-4"
        >
          <span>Progress</span>
          <span class="text-sm font-normal text-muted-foreground">
            {{ progress.current }} / {{ progress.total }} ({{
              progressPercentage
            }}%)
          </span>
        </h2>

        <!-- Progress Bar -->
        <div class="w-full h-2 bg-secondary rounded-full overflow-hidden mb-4">
          <div
            class="h-full bg-primary transition-all duration-300"
            :style="{ width: `${progressPercentage}%` }"
          />
        </div>

        <!-- Logs Section -->
        <button
          class="flex items-center gap-2 w-full text-left text-sm text-muted-foreground hover:text-foreground"
          @click="showLogs = !showLogs"
        >
          Logs
          <ChevronDown v-if="!showLogs" class="h-4 w-4" />
          <ChevronUp v-else class="h-4 w-4" />
        </button>

        <div v-if="showLogs" class="mt-2">
          <div
            id="log-container"
            class="h-64 w-full overflow-y-auto rounded-md border bg-muted/50 p-4 font-mono text-xs"
          >
            <div class="space-y-1">
              <div
                v-for="(log, index) in logs"
                :key="index"
                class="flex items-start gap-2"
              >
                <CheckCircle
                  v-if="log.level === 'success'"
                  class="h-4 w-4 shrink-0 mt-0.5 text-green-500"
                />
                <XCircle
                  v-else-if="log.level === 'error'"
                  class="h-4 w-4 shrink-0 mt-0.5 text-red-500"
                />
                <AlertCircle
                  v-else
                  class="h-4 w-4 shrink-0 mt-0.5 text-blue-500"
                />
                <span :class="{ 'text-red-500': log.level === 'error' }">
                  {{ log.message }}
                </span>
              </div>
              <div v-if="logs.length === 0" class="text-muted-foreground">
                No logs yet
              </div>
            </div>
          </div>
          <Button
            v-if="logs.length > 0"
            variant="ghost"
            size="sm"
            class="mt-2"
            @click="clearLogs"
          >
            <Trash2 class="mr-2 h-3 w-3" />
            Clear Logs
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Custom scrollbar for log container */
#log-container::-webkit-scrollbar {
  width: 8px;
}

#log-container::-webkit-scrollbar-track {
  background: transparent;
}

#log-container::-webkit-scrollbar-thumb {
  background: hsl(var(--muted-foreground) / 0.3);
  border-radius: 4px;
}

#log-container::-webkit-scrollbar-thumb:hover {
  background: hsl(var(--muted-foreground) / 0.5);
}
</style>
