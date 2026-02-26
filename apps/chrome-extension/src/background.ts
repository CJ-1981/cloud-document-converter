import {
  type Message,
  type AutomationDownloadMessage,
  Flag,
} from './common/message'

const sharedDocumentUrlPatterns: string[] = [
  'https://*.feishu.cn/*',
  'https://*.feishu.net/*',
  'https://*.larksuite.com/*',
  'https://*.feishu-pre.net/*',
  'https://*.larkoffice.com/*',
  'https://*.larkenterprise.com/*',
]

enum MenuItemId {
  DOWNLOAD_DOCX_AS_MARKDOWN = 'download_docx_as_markdown',
  COPY_DOCX_AS_MARKDOWN = 'copy_docx_as_markdown',
  VIEW_DOCX_AS_MARKDOWN = 'view_docx_as_markdown',
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MenuItemId.DOWNLOAD_DOCX_AS_MARKDOWN,
    title: chrome.i18n.getMessage('download_docx_as_markdown'),
    documentUrlPatterns: sharedDocumentUrlPatterns,
    contexts: ['page', 'editable'],
  })

  chrome.contextMenus.create({
    id: MenuItemId.COPY_DOCX_AS_MARKDOWN,
    title: chrome.i18n.getMessage('copy_docx_as_markdown'),
    documentUrlPatterns: sharedDocumentUrlPatterns,
    contexts: ['page', 'editable'],
  })

  chrome.contextMenus.create({
    id: MenuItemId.VIEW_DOCX_AS_MARKDOWN,
    title: chrome.i18n.getMessage('view_docx_as_markdown'),
    documentUrlPatterns: sharedDocumentUrlPatterns,
    contexts: ['page', 'editable'],
  })
})

const executeScriptByFlag = async (flag: string | number, tabId: number) => {
  switch (flag) {
    case MenuItemId.DOWNLOAD_DOCX_AS_MARKDOWN:
      await chrome.scripting.executeScript({
        files: ['bundles/scripts/download-lark-docx-as-markdown.js'],
        target: { tabId },
        world: 'MAIN',
      })
      break
    case MenuItemId.COPY_DOCX_AS_MARKDOWN:
      await chrome.scripting.executeScript({
        files: ['bundles/scripts/copy-lark-docx-as-markdown.js'],
        target: { tabId },
        world: 'MAIN',
      })
      break
    case MenuItemId.VIEW_DOCX_AS_MARKDOWN:
      await chrome.scripting.executeScript({
        files: ['bundles/scripts/view-lark-docx-as-markdown.js'],
        target: { tabId },
        world: 'MAIN',
      })
      break
    default:
      break
  }
}

chrome.contextMenus.onClicked.addListener(({ menuItemId }, tab) => {
  if (tab?.id !== undefined) {
    executeScriptByFlag(menuItemId, tab.id).catch(console.error)
  }
})

/**
 * Sanitize filename to remove invalid characters
 */
function sanitizeFilename(filename: string): string {
  // Remove or replace invalid characters for Windows/Linux/Mac
  return filename
    .replace(/[<>:"/\\|?*]/g, '-') // Replace invalid chars with dash
    .replace(/[\x00-\x1f\x80-\x9f]/g, '') // Remove control characters
    .replace(/^\.+/, '') // Remove leading dots
    .substring(0, 200) // Limit length
}

chrome.runtime.onMessage.addListener((_message, sender, sendResponse) => {
  const message = _message as Message

  // Handle automation download
  if ((message as AutomationDownloadMessage).type === 'AUTOMATION_DOWNLOAD') {
    const automationMessage = message as AutomationDownloadMessage

    console.log('[Automation] Received download request:', {
      filename: automationMessage.filename,
      dataSize: automationMessage.data.length,
    })

    // Sanitize filename
    const sanitizedFilename = sanitizeFilename(automationMessage.filename)
    console.log('[Automation] Sanitized filename:', sanitizedFilename)

    // Use data URL directly (more reliable than blob URL)
    const dataUrl = automationMessage.data

    chrome.downloads.download(
      {
        url: dataUrl,
        filename: sanitizedFilename,
        saveAs: false, // KEY: Bypasses Save As dialog
        conflictAction: 'uniquify', // Handle filename conflicts
      },
      downloadId => {
        if (chrome.runtime.lastError) {
          console.error(
            '[Automation] Download failed:',
            chrome.runtime.lastError,
          )
          sendResponse({
            success: false,
            error: chrome.runtime.lastError.message,
          })
        } else if (downloadId) {
          console.log('[Automation] Download started:', downloadId)

          // Wait a bit and check the download status
          setTimeout(() => {
            chrome.downloads.search({ id: downloadId }, results => {
              if (results && results[0]) {
                const download = results[0]
                console.log('[Automation] Download status:', {
                  state: download.state,
                  filename: download.filename,
                  totalBytes: download.totalBytes,
                })
              }
            })
          }, 2000)

          sendResponse({ success: true, downloadId })
        } else {
          console.error('[Automation] Download failed: no downloadId returned')
          sendResponse({ success: false, error: 'No download ID returned' })
        }
      },
    )

    return true
  }

  // Regular script execution message
  const scriptMessage = message as Extract<Message, { flag: Flag }>

  const executeScript = async () => {
    const activeTabs = await chrome.tabs.query({
      currentWindow: true,
      active: true,
    })

    const activeTabId = activeTabs.at(0)?.id

    if (activeTabs.length === 1 && activeTabId !== undefined) {
      await executeScriptByFlag(scriptMessage.flag, activeTabId)
    }
  }

  executeScript()
    .then(() => sendResponse())
    .catch(console.error)

  return true
})
