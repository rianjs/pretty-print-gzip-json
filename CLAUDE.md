# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Chrome extension called "AWS Gzipped JSON Formatter" that helps AWS console users work with gzipped JSON data in both DynamoDB and S3. The extension provides two main features:

1. **DynamoDB**: Right-click context menu and hover previews for base64-encoded gzipped JSON payloads in textareas
2. **S3**: Preview buttons for .json.gzip and .json.gz files that fetch and display the formatted content

## Development Commands

### Essential Commands
- `npm run build` - Build the extension for production
- `npm run dev` - Watch mode for development (rebuilds on file changes)
- `npm run lint` - Run ESLint to check code quality
- `npm test` - Run Jest tests
- `npm run package` - Build and create extension.zip for distribution

### Development Workflow
1. Make code changes in `src/`
2. Run `npm run dev` to watch for changes
3. Load the `dist/` folder as an unpacked extension in Chrome
4. Test changes in the AWS DynamoDB console

## Architecture

### Core Components
- **Background Script** (`src/background.ts`): Registers context menu and handles click events, sends messages to content script, shows notifications
- **Content Script** (`src/content.ts`): Main application logic as `PayloadFormatter` class with dual functionality:
  - DynamoDB: Handles payload processing, manages hover previews for textareas
  - S3: Injects preview buttons, fetches binary files, processes gzipped content
- **Popup** (`src/popup.html`): Extension popup with usage instructions for both DynamoDB and S3

### Key Features
- **Context Menu Integration**: Right-click "Copy as formatted JSON" on DynamoDB textareas
- **Hover Preview**: Shows formatted JSON preview when hovering over textareas containing valid encoded data
- **S3 Preview Buttons**: Dynamically injected "Preview" buttons next to download buttons for .json.gzip/.json.gz files
- **Binary File Processing**: Fetches S3 files directly and processes gzipped binary data
- **Theme Detection**: Automatically detects AWS console light/dark theme for proper styling
- **Error Handling**: Graceful handling of invalid data with user notifications

### Data Flow

#### DynamoDB Flow
1. User right-clicks on textarea → Background script receives context menu click
2. Background script sends message to content script → Content script processes textarea content
3. Content script decodes base64 → decompresses gzip → parses JSON → formats with indentation
4. Formatted JSON copied to clipboard → User receives notification

#### S3 Flow
1. Page loads → Content script scans for S3 objects with .json.gzip/.json.gz extensions
2. Preview buttons injected next to download buttons using DOM mutation observer
3. User clicks Preview → Content script extracts download URL and fetches binary file
4. Binary data decompressed → parsed → formatted → displayed in preview panel

### Processing Pipeline

#### DynamoDB Processing (`processPayload()`)
1. Base64 decoding using `atob()`
2. Gzip decompression using `pako.inflate()`
3. UTF-8 text decoding
4. JSON parsing and formatting with 2-space indentation

#### S3 Processing (`previewS3File()`)
1. Extract download URL from download button
2. Fetch binary file using `fetch()` API
3. Convert response to `Uint8Array`
4. Gzip decompression using `pako.inflate()`
5. UTF-8 text decoding and JSON formatting

## Technical Stack
- **TypeScript** with strict type checking
- **Webpack** for bundling with ts-loader
- **Pako** library for gzip compression/decompression
- **ESLint 9** with flat config for code linting
- **Jest** with jsdom environment for testing
- **Chrome Extensions Manifest V3**

## Build Configuration
- **webpack.config.js**: Bundles TypeScript files, copies static assets (manifest, popup, icons)
- **tsconfig.json**: TypeScript configuration with ES2020 target
- **eslint.config.js**: Modern flat config with TypeScript rules
- **jest.config.js**: Test configuration for TypeScript files

## Extension Permissions
- `contextMenus`: Right-click menu integration
- `activeTab`: Access to current tab for content script messaging
- `notifications`: Show success/error notifications
- Host permissions limited to `https://*.console.aws.amazon.com/*`

## Testing Notes
- Tests should be placed in `tests/` directory or alongside source files with `.test.ts` extension
- Use Jest with jsdom environment for DOM-based testing
- Test both DynamoDB and S3 processing pipelines:
  - DynamoDB: Various base64/gzip inputs
  - S3: Binary file fetching and processing
- Mock Chrome APIs for background script testing
- Test DOM injection and mutation observer functionality for S3

## S3 Implementation Details
- **File Detection**: Looks for files ending with `.json.gzip` or `.json.gz`
- **Button Injection**: Uses `MutationObserver` to watch for new S3 object elements
- **DOM Selectors**: Multiple fallback selectors to find download buttons and filenames
- **URL Extraction**: Attempts to extract download URLs from various button configurations
- **Error Handling**: Shows temporary notifications for failed preview attempts