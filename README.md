# DynamoDB Payload Formatter

A Chrome extension that allows you to right-click on base64-encoded gzipped JSON payloads in the AWS DynamoDB console and copy them as formatted JSON.

## Features

- Right-click context menu integration
- Automatic base64 decoding
- Gzip decompression
- JSON formatting with proper indentation
- Copy to clipboard functionality
- Error notifications for invalid data

## Development Setup

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd dynamodb-payload-formatter

# Install dependencies
npm install

# Build the extension
npm run build
```

### Development Workflow

```bash
# Watch mode for development
npm run dev

# Run linter
npm run lint

# Run tests
npm test

# Package for distribution
npm run package
```

### Loading the Extension

1. Build the extension using `npm run build`
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the `dist/` folder

## Usage

1. Navigate to the AWS DynamoDB console
2. Open an item that contains a base64-encoded gzipped JSON payload
3. Right-click on the textarea containing the encoded data
4. Select "Copy as formatted JSON" from the context menu
5. The formatted JSON will be copied to your clipboard

## Project Structure

```
├── src/
│   ├── content.ts          # Content script for textarea detection and formatting
│   ├── background.ts       # Background script for context menu registration
│   └── popup.html         # Extension popup interface
├── icons/                 # Extension icons (add your own)
├── manifest.json          # Chrome extension manifest
├── webpack.config.js      # Build configuration
├── tsconfig.json          # TypeScript configuration
├── .eslintrc.js          # ESLint configuration
└── package.json           # Dependencies and scripts
```

## Technologies Used

- **TypeScript** - Type-safe development
- **Webpack** - Module bundling and build process
- **Pako** - Gzip compression/decompression
- **ESLint** - Code linting
- **Jest** - Testing framework (configured but tests need to be written)
- **GitHub Actions** - CI/CD pipeline

## CI/CD

The project includes a GitHub Actions workflow that:
- Runs linting and tests on every push and PR
- Builds the extension
- Packages the extension for distribution
- Automatically creates release artifacts when a GitHub release is published

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Ensure tests pass and code is linted
5. Submit a pull request

## License

MIT License - see LICENSE file for details