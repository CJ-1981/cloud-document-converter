import type { WikiPageInfo } from './wiki-detector'

// Re-export for convenience
export type { WikiPageInfo } from './wiki-detector'

export interface WikiManifest {
  title: string
  rootUrl: string
  totalFiles: number
  pages: WikiPageInfo[]
  generatedAt: string
}

/**
 * Generate a markdown manifest file from wiki page info
 */
export function generateMarkdownManifest(manifest: WikiManifest): string {
  const lines: string[] = []

  // Header
  lines.push(`# ${manifest.title}\n`)
  lines.push(`**Wiki Export Manifest**\n`)
  lines.push(`- **Root URL:** ${manifest.rootUrl}`)
  lines.push(`- **Total Files:** ${String(manifest.totalFiles)}`)
  lines.push(
    `- **Generated:** ${new Date(manifest.generatedAt).toLocaleString()}\n`,
  )
  lines.push(`---\n`)

  // Table of contents
  lines.push(`## 📑 File Index\n`)
  lines.push(`| # | File | Title | Depth | URL |`)
  lines.push(`|---|------|-------|-------|-----|`)

  manifest.pages.forEach((page, index) => {
    const depthIndicator = '  '.repeat(page.depth)
    const filename = page.downloadFilename ?? `${String((page.index ?? index) + 1)}.md`
    const title = page.title ?? 'Untitled'
    const url = shortenUrl(page.url)

    lines.push(
      `| ${String(index + 1)} | \`${filename}\` | ${depthIndicator}${title} | ${String(page.depth)} | [View](${url}) |`,
    )
  })

  lines.push(`\n---\n`)

  // Tree view
  lines.push(`## 🌳 Wiki Structure (Tree View)\n`)

  const tree = buildTree(manifest.pages)
  lines.push(renderTree(tree))

  return lines.join('\n')
}

/**
 * Generate a CSV manifest file from wiki page info
 */
export function generateCSVManifest(manifest: WikiManifest): string {
  const lines: string[] = []

  // Header
  lines.push('#,Filename,Title,Depth,Parent URL,URL')

  manifest.pages.forEach((page, index) => {
    const filename = page.downloadFilename ?? `${String((page.index ?? index) + 1)}.md`
    const title = (page.title ?? 'Untitled').replace(/"/g, '""') // Escape quotes
    const url = page.url
    const parentUrl = page.parentUrl ?? ''

    lines.push(
      `${String(index + 1)},"${filename}","${title}",${String(page.depth)},"${parentUrl}","${url}"`,
    )
  })

  return lines.join('\n')
}

/**
 * Build a tree structure from flat page list
 */
interface TreeNode {
  page: WikiPageInfo
  children: TreeNode[]
}

function buildTree(pages: WikiPageInfo[]): TreeNode[] {
  const map = new Map<string, TreeNode>()
  const roots: TreeNode[] = []

  // Create nodes
  pages.forEach(page => {
    map.set(page.url, { page, children: [] })
  })

  // Build tree
  pages.forEach(page => {
    const node = map.get(page.url)!

    if (!page.parentUrl || !map.has(page.parentUrl)) {
      roots.push(node)
    } else {
      const parent = map.get(page.parentUrl)!
      parent.children.push(node)
    }
  })

  // Debug logging
  console.log('[Manifest] Tree structure:')
  roots.forEach(root => {
    console.log(`  Root: ${root.page.title || root.page.url}`)
    root.children.forEach(child => {
      console.log(`    Child: ${child.page.title || child.page.url}`)
    })
  })

  return roots
}

/**
 * Render tree as ASCII/Markdown
 */
function renderTree(nodes: TreeNode[], prefix: string = ''): string {
  const lines: string[] = []

  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1
    const connector = isLast ? '└── ' : '├── '
    const title = node.page.title ?? node.page.downloadFilename ?? 'Untitled'
    const filename =
      node.page.downloadFilename ?? `${String((node.page.index ?? 0) + 1)}.md`

    lines.push(`${prefix}${connector}${title} (\`${filename}\`)`)

    // Render children
    if (node.children.length > 0) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ')
      const childLines = renderTree(node.children, childPrefix)
      // Split and push each line to avoid flattening
      childLines.split('\n').forEach(line => lines.push(line))
    }
  })

  return lines.join('\n')
}

/**
 * Shorten URL for display
 */
function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // Keep last part of path for brevity
    const parts = parsed.pathname.split('/').filter(Boolean)
    const lastPart = parts[parts.length - 1] || parsed.pathname
    return `.../${lastPart}`
  } catch {
    return url
  }
}

/**
 * Generate filename for a page
 */
export function generateFilename(page: WikiPageInfo, index: number): string {
  if (page.title) {
    // Use title, sanitize it
    const sanitized = page.title
      .replace(/[<>:"/\\|?*]/g, '-') // Remove invalid chars
      .replace(/\s+/g, '_') // Spaces to underscores
      .substring(0, 100) // Limit length

    return `${sanitized}.md`
  }

  return `page_${index + 1}.md`
}
