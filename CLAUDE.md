# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloud Document Converter is a browser extension (Chrome, Firefox, Edge) that converts Lark/Feishu documents to Markdown. The project is a monorepo using pnpm workspaces with TypeScript.

## Architecture

### Monorepo Structure

```
apps/
  chrome-extension/     # Main browser extension
packages/
  common/              # Shared utilities (DOM, SVG, image, number, time functions)
  lark/                # Lark document parsing and conversion core
  typescript-config/   # Shared TypeScript configuration
```

### Core Conversion Flow

1. **Document Access**: The extension's content script (`content.ts`) injects buttons into Lark document pages
2. **User Action**: User clicks download/copy/view button, triggering a background script message
3. **Script Execution**: Background script injects the appropriate action script into MAIN world
4. **Document Parsing**: The script accesses `PageMain.blockManager.rootBlockModel` from Lark's global state
5. **Block Traversal**: Lark documents are composed of nested block structures (see `BlockType` enum in `packages/lark/src/docx.ts`)
6. **AST Transformation**: Blocks are transformed to mdast (Markdown AST) nodes via `Transformer` class
7. **Markdown Generation**: mdast is converted to Markdown string using `mdast-util-to-markdown`

### Key Data Structures

- **Blocks**: Lark documents are trees of block objects with types like `PAGE`, `HEADING1-6`, `TEXT`, `CODE`, `TABLE`, `IMAGE`, etc.
- **Transformer**: Converts Lark blocks to mdast with configurable options (whiteboard, diagram, file, highlight, flatGrid)
- **mdast Extension**: The project extends mdast types with custom data properties for images, files, links, and inline code

### Communication Patterns

- **Background ↔ Content**: Chrome runtime messages via `chrome.runtime.sendMessage`
- **Content ↔ Page**: Custom event-based message system using `receiver` from `@dolphin/common`
- **Settings**: Stored in `chrome.storage.sync` and accessed via `getSettings()`

## Development Commands

### Root Level
```bash
# Install dependencies
pnpm i

# Build all packages
pnpm build

# Type check all
pnpm type-check

# Run all tests
pnpm test

# Lint
pnpm lint

# Format
pnpm format
```

### Chrome Extension Development
```bash
cd apps/chrome-extension

# Build with watch mode
pnpm run build --watch

# Build for Firefox
pnpm run build --watch --target firefox

# Run extension (with web-ext)
pnpm exec web-ext run --source-dir dist --target chromium
pnpm exec web-ext run --source-dir dist --target firefox-desktop

# Type check only
pnpm run type-check

# Run tests
pnpm run test

# Dev server for options page
pnpm run dev:pages
```

### Package Development
```bash
# For @dolphin/lark
cd packages/lark
pnpm run build
pnpm run test
pnpm run type-check

# For @dolphin/common
cd packages/common
pnpm run build
pnpm run test
pnpm run type-check
```

## Important Implementation Details

### Block Type Handling

- **Supported blocks**: PAGE, DIVIDER, HEADING1-6, CODE, QUOTE_CONTAINER, BULLET/ORDERED/TODO lists, TEXT, TABLE, IMAGE, IFAME, ISV (TextDrawing, Timeline)
- **Conditionally supported**: WHITEBOARD (requires whiteboard option), DIAGRAM (requires diagram option), FILE (requires file option)
- **Not supported**: BITABLE, CHAT_CARD, MINDNOTE, SHEET, FALLBACK (returns null)
- **Level 7-9 headings**: Converted to paragraphs (Lark-specific behavior)
- **Grid blocks**: Can be flattened when `flatGrid` option is enabled

### Lark Global Objects

The extension relies on Lark's page-level globals:
- `PageMain.blockManager.rootBlockModel`: Access document structure
- `PageMain.locateBlockWithRecordIdImpl(recordId)`: Programmatically scroll to blocks
- `User.language`: Detect document language (zh/en)

### Image and File Handling

Images and files are not embedded directly. Instead, they include metadata with fetch functions:
```typescript
interface ImageData {
  name?: string
  token?: string
  fetchSources?: () => Promise<ImageSources | null>
  fetchBlob?: () => Promise<Blob | null>
}
```

This allows deferred downloading and bundling into ZIP files.

### Internationalization

- Extension UI uses Chrome i18n (`chrome.i18n.getMessage`)
- Download scripts use i18next for runtime translations
- User-facing strings are defined in `_locales/{en,zh_CN}/messages.json`
- Code imports from `src/common/i18n.ts` for shared translations

### Build System

- **Packages**: Built with `tsdown` (TypeScript bundler)
- **Extension scripts**: Built with `rolldown-vite` via custom CLI (`scripts/cli.ts`)
- **Options/popup pages**: Built with Vite + Vue
- Type definitions are generated as `.d.mts` files

### Test Strategy

- Unit tests use Vitest
- Tests verify block-to-mdast transformations
- Located in `packages/*/tests/` and `apps/chrome-extension/tests/`
- Mock `PageMain` and other Lark globals when testing in isolation

## Adding New Block Types

To add support for a new Lark block type:

1. Add the `BlockType` enum value to `packages/lark/src/docx.ts`
2. Define the block interface extending `Block`
3. Add a case in `Transformer._transform()` method
4. Update the `Mutate<T>` type mapping
5. Add tests in `packages/lark/tests/docx.test.ts` or a new test file
6. Document support level in README.md compatibility table

## Common Patterns

### Accessing document content
```typescript
import { docx, Docx } from '@dolphin/lark'

const docx = new Docx()
if (docx.isReady()) {
  const { root, images, files } = docx.intoMarkdownAST({ whiteboard: true })
  const markdown = Docx.stringify(root)
}
```

### Reading user settings
```typescript
import { getSettings, SettingKey } from '@/common/settings'

const settings = await getSettings()
const downloadMethod = settings[SettingKey.DownloadMethod]
```

### Message passing
```typescript
// From content/page script
import { receiver, EventName } from './common/message'

receiver.on(EventName.GetSettings, async (keys) => {
  return await chrome.storage.sync.get(keys)
})
```

### Debugging extension scripts
When developing, logs from MAIN world scripts can be forwarded:
```typescript
// In content.ts (ISOLATED world)
if (import.meta.env.DEV) {
  receiver.on(EventName.Console, (data) => {
    console.log('MAIN World Console:', ...data)
  })
}
```
