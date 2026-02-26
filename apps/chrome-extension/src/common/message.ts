import { Port } from '@dolphin/common/message'

export enum Flag {
  ExecuteViewScript = 'view_docx_as_markdown',
  ExecuteCopyScript = 'copy_docx_as_markdown',
  ExecuteDownloadScript = 'download_docx_as_markdown',
}

interface ExecuteScriptMessage {
  flag: Flag
}

export interface AutomationDownloadMessage {
  type: 'AUTOMATION_DOWNLOAD'
  filename: string
  data: string // base64 data URL
}

export interface AutomationProgressMessage {
  type: 'AUTOMATION_PROGRESS'
  jobId: string
  status: 'pending' | 'downloading' | 'completed' | 'failed'
  current: number
  total: number
  message?: string
  title?: string
}

export interface AutomationWikiDiscoveryMessage {
  type: 'AUTOMATION_WIKI_DISCOVERY'
  urls: string[]
  depth: number
}

export type Message =
  | ExecuteScriptMessage
  | AutomationDownloadMessage
  | AutomationProgressMessage
  | AutomationWikiDiscoveryMessage

export enum EventName {
  Console = 'console',
  GetSettings = 'get_settings',
  AutomationLog = 'automation_log',
  AutomationProgress = 'automation_progress',
}

export interface Events extends Record<string, unknown> {
  [EventName.Console]: unknown[]
  [EventName.GetSettings]: string[]
  [EventName.AutomationLog]: {
    level: 'info' | 'error' | 'success'
    message: string
  }
  [EventName.AutomationProgress]: {
    current: number
    total: number
    status: string
  }
}

export const sender: Port<Events> = /* @__PURE__ */ new Port<Events>(
  'sender',
  'receiver',
)

export const receiver: Port<Events> = /* @__PURE__ */ new Port<Events>(
  'receiver',
  'sender',
)
