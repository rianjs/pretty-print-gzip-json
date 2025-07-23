import * as pako from 'pako';

interface FormatResult {
  success: boolean;
  data?: string;
  error?: string;
}

interface PreviewPanel {
  element: HTMLDivElement;
  content: HTMLDivElement;
  copyButton: HTMLButtonElement;
  isVisible: boolean;
}

class PayloadFormatter {
  private _lastRightClickedElement: HTMLElement | null = null;
  private _hoverTimeout: number | null = null;
  private _previewPanel: PreviewPanel | null = null;
  private _currentHoveredTextarea: HTMLTextAreaElement | null = null;
  private _lastMouseMoveTime = 0;
  private readonly _hoverDelay = 300;
  private readonly _mouseMoveThrottle = 100; // Throttle mousemove events
  private _debugMode = true; // Set to true to enable console logging - enabled for testing
  private _observedElements = new Set<HTMLElement>();

  constructor() {
    this.attachEventListeners();
    this.registerMessageHandler();
    this.createPreviewPanel();
    this.initializeS3Support();
    
    // Enable debug mode by setting window.dynamoDBFormatterDebug = true in console
    if ((window as unknown as { dynamoDBFormatterDebug?: boolean }).dynamoDBFormatterDebug) {
      this._debugMode = true;
    }
    
    // Add console message for debugging
    console.log('AWS Gzipped JSON Formatter loaded', {
      isS3Console: this.isInS3Console(),
      isDynamoDBConsole: this.isInDynamoDBConsole(),
      isS3ObjectDetailPage: this.isS3ObjectDetailPage(),
      url: window.location.href
    });
  }

  private debug(message: string, ...args: unknown[]): void {
    if (this._debugMode) {
      console.debug('DynamoDB Formatter:', message, ...args);
    }
  }

  private attachEventListeners(): void {
    document.addEventListener('contextmenu', (event) => {
      this._lastRightClickedElement = event.target as HTMLElement;
    });

    // Only mousemove handles hover detection for DynamoDB
    if (this.isInDynamoDBConsole()) {
      document.addEventListener('mousemove', this.handleMouseMove.bind(this), true);
    }
  
    // Hide panel when clicking outside
    document.addEventListener('click', (event) => {
      if (this._previewPanel?.isVisible && !this._previewPanel.element.contains(event.target as Node)) {
        this.hidePreviewPanel();
      }
    });
  }

  private registerMessageHandler(): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'formatPayload') {
        const result = this.formatCurrentElement();
        sendResponse(result);
      }
    });
  }

  private createPreviewPanel(): void {
    const panel = document.createElement('div');
    panel.className = 'dynamodb-preview-panel';
    
    const theme = this.detectAWSTheme();
    const styles = this.getThemeStyles(theme);
    
    panel.style.cssText = `
      position: fixed;
      background: ${styles.background};
      color: ${styles.text};
      border: 1px solid ${styles.border};
      border-radius: 8px;
      padding: 12px;
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      font-size: 12px;
      line-height: 1.4;
      max-width: 500px;
      max-height: 400px;
      overflow: hidden;
      z-index: 10000;
      display: none;
      box-shadow: 0 10px 25px ${styles.shadow};
      backdrop-filter: blur(8px);
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid ${styles.border};
    `;

    const title = document.createElement('span');
    title.textContent = 'JSON Preview';
    title.style.cssText = `
      font-weight: 600;
      color: ${styles.textSecondary};
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    `;

    const copyButton = document.createElement('button');
    copyButton.textContent = 'Copy';
    copyButton.style.cssText = `
      background: ${styles.buttonBg};
      color: ${styles.buttonText};
      border: none;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: background-color 0.2s;
    `;

    copyButton.addEventListener('mouseenter', (): void => {
      copyButton.style.background = styles.buttonHover;
    });

    copyButton.addEventListener('mouseleave', (): void => {
      copyButton.style.background = styles.buttonBg;
    });

    const content = document.createElement('div');
    content.style.cssText = `
      white-space: pre-wrap;
      overflow: auto;
      max-height: 350px;
      scrollbar-width: thin;
      scrollbar-color: ${styles.scrollThumb} transparent;
    `;

    // Custom scrollbar for webkit browsers (theme-aware)
    const style = document.createElement('style');
    style.textContent = `
      .dynamodb-preview-panel div::-webkit-scrollbar {
        width: 6px;
      }
      .dynamodb-preview-panel div::-webkit-scrollbar-track {
        background: transparent;
      }
      .dynamodb-preview-panel div::-webkit-scrollbar-thumb {
        background: ${styles.scrollThumb};
        border-radius: 3px;
      }
      .dynamodb-preview-panel div::-webkit-scrollbar-thumb:hover {
        background: ${styles.scrollThumbHover};
      }
    `;
    document.head.appendChild(style);

    header.appendChild(title);
    header.appendChild(copyButton);
    panel.appendChild(header);
    panel.appendChild(content);
    document.body.appendChild(panel);

    this._previewPanel = {
      element: panel,
      content,
      copyButton,
      isVisible: false
    };

    // Hide panel when clicking outside
    document.addEventListener('click', (event) => {
      if (this._previewPanel?.isVisible && !this._previewPanel.element.contains(event.target as Node)) {
        this.hidePreviewPanel();
      }
    });

    // Prevent panel from disappearing when hovering over it
    panel.addEventListener('mouseenter', () => {
      if (this._hoverTimeout) {
        clearTimeout(this._hoverTimeout);
        this._hoverTimeout = null;
      }
    });
  }

  private detectAWSTheme(): 'light' | 'dark' {
    // Check for dark theme indicators in AWS console
    const body = document.body;
    const html = document.documentElement;
    
    // AWS console uses data-theme or class-based theme switching
    if (body.dataset.theme === 'dark' || html.dataset.theme === 'dark') {
      return 'dark';
    }
    
    if (body.classList.contains('awsui-dark-mode') || html.classList.contains('awsui-dark-mode')) {
      return 'dark';
    }
    
    // Check computed background color of main elements
    const mainElement = document.querySelector('main') || document.querySelector('[data-testid="main-content"]') || body;
    const computedStyle = window.getComputedStyle(mainElement);
    const backgroundColor = computedStyle.backgroundColor;
    
    // Parse RGB values to determine if dark
    const rgbMatch = backgroundColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      const [, r, g, b] = rgbMatch.map(Number);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.5 ? 'dark' : 'light';
    }
    
    // Fallback to system preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private getThemeStyles(theme: 'light' | 'dark'): { [key: string]: string } {
    if (theme === 'dark') {
      return {
        background: '#2d3748',
        text: '#e2e8f0',
        textSecondary: '#cbd5e0',
        border: '#4a5568',
        shadow: 'rgba(0, 0, 0, 0.3)',
        buttonBg: '#4299e1',
        buttonText: 'white',
        buttonHover: '#3182ce',
        scrollThumb: '#4a5568',
        scrollThumbHover: '#718096',
        errorText: '#fed7d7',
        successBg: '#48bb78'
      };
    } else {
      return {
        background: '#ffffff',
        text: '#2d3748',
        textSecondary: '#4a5568',
        border: '#e2e8f0',
        shadow: 'rgba(0, 0, 0, 0.15)',
        buttonBg: '#3182ce',
        buttonText: 'white',
        buttonHover: '#2c5aa0',
        scrollThumb: '#cbd5e0',
        scrollThumbHover: '#a0aec0',
        errorText: '#e53e3e',
        successBg: '#38a169'
      };
    }
  }

  private handleMouseMove(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const now = Date.now();
  
    // Throttle mousemove events
    if (now - this._lastMouseMoveTime < this._mouseMoveThrottle) {
      return;
    }
    this._lastMouseMoveTime = now;
  
    if (target.tagName === 'TEXTAREA' && this.isInDynamoDBConsole()) {
      if (this._currentHoveredTextarea !== target) {
        // Entered a new textarea
        this.startHoverTimer(target as HTMLTextAreaElement);
      }
    } else {
      // Check if we moved to the preview panel - if so, don't hide it
      const isOverPreviewPanel = this._previewPanel?.element.contains(target);
      
      if (!isOverPreviewPanel && this._currentHoveredTextarea !== null) {
        // Moved off a textarea to something else (not the preview panel)
        this._currentHoveredTextarea = null;
        this.clearHoverTimer();
        
        // Delay hiding to allow moving to the preview panel
        setTimeout(() => {
          if (!this._previewPanel?.element.matches(':hover')) {
            this.hidePreviewPanel();
          }
        }, 100);
      }
    }
  }

  private startHoverTimer(textarea: HTMLTextAreaElement): void {
    // Clear any existing timer
    this.clearHoverTimer();
    
    this._currentHoveredTextarea = textarea;
    
    this.debug('starting hover timer');
    this._hoverTimeout = window.setTimeout(() => {
      this.debug('hover timer fired');
      if (this._currentHoveredTextarea === textarea) {
        this.showPreviewForTextarea(textarea);
      }
    }, this._hoverDelay);
  }

  private clearHoverTimer(): void {
    if (this._hoverTimeout) {
      this.debug('clearing hover timer');
      clearTimeout(this._hoverTimeout);
      this._hoverTimeout = null;
    }
  }

  private handleMouseLeave(event: Event): void {
    const target = event.target as HTMLElement;
    
    if (target.tagName === 'TEXTAREA') {
      this.debug('mouseleave on textarea');
      
      // Clear the current textarea if we're leaving it
      if (this._currentHoveredTextarea === target) {
        this._currentHoveredTextarea = null;
      }

      this.clearHoverTimer();

      // Delay hiding to allow moving to the preview panel
      setTimeout(() => {
        if (!this._previewPanel?.element.matches(':hover')) {
          this.hidePreviewPanel();
        }
      }, 100);
    }
  }

  private isInDynamoDBConsole(): boolean {
    return window.location.hostname.includes('console.aws.amazon.com') && 
           window.location.pathname.includes('dynamodb');
  }

  private isInS3Console(): boolean {
    return window.location.hostname.includes('console.aws.amazon.com') && 
           window.location.pathname.includes('s3');
  }

  private isInAWSConsole(): boolean {
    return window.location.hostname.includes('console.aws.amazon.com');
  }

  private isS3ObjectDetailPage(): boolean {
    if (!this.isInS3Console()) {
      return false;
    }
    
    const url = window.location.href;
    const path = window.location.pathname;
    const search = window.location.search;
    
    // Check various URL patterns for S3 object detail pages
    return (
      path.includes('/object/') ||
      search.includes('prefix=') ||
      search.includes('tab=overview') ||
      search.includes('tab=properties') ||
      url.includes('&prefix=') ||
      document.title.includes('Object overview') ||
      // Check for object-specific patterns in the URL
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.test(url) ||
      /\.json\.gz/.test(url) ||
      /\.json\.gzip/.test(url)
    );
  }

  private handleS3ObjectDetailPage(): void {
    this.debug('Handling S3 object detail page');
    
    // Check if we already have a preview button to avoid duplicates
    if (document.querySelector('.dynamodb-preview-btn')) {
      this.debug('Preview button already exists, skipping');
      return;
    }
    
    // Extract filename from URL or page elements
    const fileName = this.extractS3FileNameFromPage();
    if (fileName && this.isGzippedJsonFile(fileName)) {
      this.debug('Found gzipped JSON file on detail page:', fileName);
      this.injectPreviewButtonOnDetailPage(fileName);
    } else {
      this.debug('No valid gzipped JSON file found on detail page. Filename:', fileName);
    }
  }

  private extractS3FileNameFromPage(): string | null {
    // Try to get filename from URL
    const urlParts = window.location.pathname.split('/');
    const lastPart = urlParts[urlParts.length - 1];
    if (lastPart && (lastPart.endsWith('.json.gzip') || lastPart.endsWith('.json.gz'))) {
      return decodeURIComponent(lastPart);
    }

    // Try to get from URL search params
    const urlParams = new URLSearchParams(window.location.search);
    const prefix = urlParams.get('prefix');
    if (prefix && (prefix.endsWith('.json.gzip') || prefix.endsWith('.json.gz'))) {
      return prefix;
    }

    // Try to get from page title or breadcrumbs
    const titleMatch = document.title.match(/([^/]+\.(json\.gzip|json\.gz))/i);
    if (titleMatch) {
      return titleMatch[1];
    }

    // Look for object name in the page
    const selectors = [
      'h1',
      '[data-testid*="object-name"]',
      '.object-name',
      'breadcrumb'
    ];

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      for (const element of elements) {
        const text = element.textContent?.trim();
        if (text && (text.endsWith('.json.gzip') || text.endsWith('.json.gz'))) {
          return text;
        }
      }
    }

    return null;
  }

  private injectPreviewButtonOnDetailPage(fileName: string): void {
    this.debug('Injecting preview button on detail page for:', fileName);
    
    let downloadButton: HTMLElement | null = null;
    
    // Search for Download button by text content
    const allButtons = Array.from(document.querySelectorAll('button'));
    for (const btn of allButtons) {
      if (btn.textContent?.toLowerCase().includes('download')) {
        downloadButton = btn;
        this.debug('Found download button on detail page:', btn.textContent);
        break;
      }
    }

    if (downloadButton && !downloadButton.parentElement?.querySelector('.dynamodb-preview-btn')) {
      this.createAndInsertPreviewButton(downloadButton, fileName);
    }
  }

  private createAndInsertPreviewButton(downloadButton: HTMLElement, fileName: string): void {
    const previewButton = document.createElement('button');
    previewButton.textContent = 'Preview';
    previewButton.className = 'dynamodb-preview-btn';
    
    const theme = this.detectAWSTheme();
    const styles = this.getThemeStyles(theme);
    
    previewButton.style.cssText = `
      background: ${styles.buttonBg};
      color: ${styles.buttonText};
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      margin-left: 8px;
      font-size: 12px;
      cursor: pointer;
      transition: background-color 0.2s;
    `;

    previewButton.addEventListener('mouseenter', (): void => {
      previewButton.style.background = styles.buttonHover;
    });

    previewButton.addEventListener('mouseleave', (): void => {
      previewButton.style.background = styles.buttonBg;
    });

    previewButton.addEventListener('click', async (event): Promise<void> => {
      event.preventDefault();
      event.stopPropagation();
      await this.previewS3FileFromDetailPage(fileName, downloadButton);
    });

    // Insert the preview button after the download button
    if (downloadButton.parentNode) {
      downloadButton.parentNode.insertBefore(previewButton, downloadButton.nextSibling);
      this.debug('Preview button inserted on detail page');
    }
  }

  private showPreviewForTextarea(textarea: HTMLTextAreaElement): void {
    if (!this._previewPanel || !textarea.value.trim()) {
      return;
    }
  
    const result = this.processPayload(textarea.value.trim());
  
    if (result.success && result.data) {
      this.showPreviewPanel(result.data, textarea);
  
      this._previewPanel.copyButton.onclick = (): void => {
        this.copyToClipboard(result.data!);
        this.showCopyFeedback();
      };
    } else {
      // Normal case: nothing to preview; do nothing
      this.hidePreviewPanel();
    }
  }


  private showPreviewPanel(content: string, textarea: HTMLTextAreaElement): void {
    if (!this._previewPanel) return;

    this._previewPanel.content.textContent = content;
    this._previewPanel.isVisible = true;
    this._previewPanel.element.style.display = 'block';

    this.positionPanel(textarea);
  }

  private showErrorPreview(error: string, textarea: HTMLTextAreaElement): void {
    if (!this._previewPanel) return;

    const theme = this.detectAWSTheme();
    const styles = this.getThemeStyles(theme);

    this._previewPanel.content.textContent = `Error: ${error}`;
    this._previewPanel.content.style.color = styles.errorText;
    this._previewPanel.copyButton.style.display = 'none';
    this._previewPanel.isVisible = true;
    this._previewPanel.element.style.display = 'block';

    this.positionPanel(textarea);

    // Reset styles after a delay
    setTimeout(() => {
      if (this._previewPanel) {
        const currentStyles = this.getThemeStyles(this.detectAWSTheme());
        this._previewPanel.content.style.color = currentStyles.text;
        this._previewPanel.copyButton.style.display = 'block';
      }
    }, 3000);
  }

  private positionPanel(textarea: HTMLTextAreaElement): void {
    if (!this._previewPanel) return;

    const rect = textarea.getBoundingClientRect();
    const panel = this._previewPanel.element;
    
    // Position to the right of the textarea, or left if no space
    let left = rect.right + 10;
    let top = rect.top;

    // Check if panel would go off-screen
    if (left + 500 > window.innerWidth) {
      left = rect.left - 510; // Position to the left
    }

    // Ensure panel doesn't go below viewport
    if (top + 400 > window.innerHeight) {
      top = window.innerHeight - 400 - 10;
    }

    // Ensure panel doesn't go above viewport
    if (top < 10) {
      top = 10;
    }

    panel.style.left = `${Math.max(10, left)}px`;
    panel.style.top = `${top}px`;
  }

  private hidePreviewPanel(): void {
    if (this._previewPanel && this._previewPanel.isVisible) {
      this.debug('hiding preview panel');
      this._previewPanel.element.style.display = 'none';
      this._previewPanel.isVisible = false;
    }

    this.clearHoverTimer();
  }

  private showCopyFeedback(): void {
    if (!this._previewPanel) return;

    const theme = this.detectAWSTheme();
    const styles = this.getThemeStyles(theme);

    const originalText = this._previewPanel.copyButton.textContent;
    this._previewPanel.copyButton.textContent = 'Copied!';
    this._previewPanel.copyButton.style.background = styles.successBg;

    setTimeout(() => {
      if (this._previewPanel) {
        this._previewPanel.copyButton.textContent = originalText;
        this._previewPanel.copyButton.style.background = styles.buttonBg;
      }
    }, 1000);
  }

  private formatCurrentElement(): FormatResult {
    if (!this._lastRightClickedElement) {
      return { success: false, error: 'No element selected' };
    }

    const textarea = this._lastRightClickedElement as HTMLTextAreaElement;
    if (textarea.tagName !== 'TEXTAREA') {
      return { success: false, error: 'Selected element is not a textarea' };
    }

    const content = textarea.value.trim();
    if (!content) {
      return { success: false, error: 'Textarea is empty' };
    }

    const result = this.processPayload(content);
    
    if (result.success && result.data) {
      this.copyToClipboard(result.data);
    }

    return result;
  }

  private processPayload(base64Content: string): FormatResult {
    try {
      const binaryData = this.decodeBase64(base64Content);
      const decompressedData = this.decompressGzip(binaryData);
      const jsonString = new TextDecoder().decode(decompressedData);
      const parsedJson = JSON.parse(jsonString);
      const formattedJson = JSON.stringify(parsedJson, null, 2);
  
      return { success: true, data: formattedJson };
    } catch {
      // Instead of treating this as an error, treat it as "not decodable"
      return { success: false };
    }
  }

  private decodeBase64(base64String: string): Uint8Array {
    try {
      const binaryString = atob(base64String);
      const bytes = new Uint8Array(binaryString.length);
      
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      return bytes;
    } catch {
      throw new Error('Invalid base64 encoding');
    }
  }

  private decompressGzip(compressedData: Uint8Array): Uint8Array {
    try {
      return pako.inflate(compressedData);
    } catch {
      throw new Error('Failed to decompress gzip data');
    }
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
  }

  // S3-specific functionality
  private initializeS3Support(): void {
    if (!this.isInS3Console()) {
      this.debug('Not in S3 console, skipping S3 support');
      return;
    }

    this.debug('Initializing S3 support', window.location.href);
    
    // Special handling for S3 object detail pages
    if (this.isS3ObjectDetailPage()) {
      this.debug('Detected S3 object detail page');
      // Use multiple attempts with increasing delays for SPA navigation
      setTimeout(() => this.handleS3ObjectDetailPage(), 500);
      setTimeout(() => this.handleS3ObjectDetailPage(), 1500);
      setTimeout(() => this.handleS3ObjectDetailPage(), 3000);
    }
    
    // Also listen for URL changes (for SPAs)
    let currentUrl = window.location.href;
    const checkUrlChange = (): void => {
      if (window.location.href !== currentUrl) {
        currentUrl = window.location.href;
        this.debug('URL changed to:', currentUrl);
        if (this.isS3ObjectDetailPage()) {
          setTimeout(() => this.handleS3ObjectDetailPage(), 1000);
        }
      }
    };
    
    // Check for URL changes periodically
    setInterval(checkUrlChange, 1000);
    
    // Watch for DOM changes to inject preview buttons
    const observer = new MutationObserver((mutations) => {
      try {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                // Throttle processing to avoid excessive calls
                setTimeout(() => {
                  try {
                    this.processS3Elements(node as Element);
                  } catch (error) {
                    this.debug('Error processing S3 elements:', error);
                  }
                }, 100);
              }
            });
          }
        }
      } catch (error) {
        this.debug('Error in mutation observer:', error);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Process existing elements
    this.processS3Elements(document.body);
  }

  private processS3Elements(element: Element): void {
    this.debug('Processing S3 elements in:', element.tagName, element.className);
    
    // Look for various S3 elements - cast broader net
    const selectors = [
      '[data-testid="object-list-item"]',
      '.s3-object-row',
      '[class*="object"]',
      '[class*="file"]',
      '[class*="row"]',
      'tr',
      'div[role="row"]',
      '[data-testid*="object"]',
      '[data-testid*="file"]'
    ];
    
    const allElements = new Set<Element>();
    selectors.forEach(selector => {
      element.querySelectorAll(selector).forEach(el => allElements.add(el));
    });
    
    this.debug(`Found ${allElements.size} potential S3 elements`);
    
    allElements.forEach((objectElement) => {
      if (this._observedElements.has(objectElement as HTMLElement)) {
        return;
      }
      
      const fileName = this.extractS3FileName(objectElement);
      this.debug('Checking element for filename:', fileName, objectElement);
      
      if (fileName && this.isGzippedJsonFile(fileName)) {
        this.debug('Found gzipped JSON file:', fileName);
        this._observedElements.add(objectElement as HTMLElement);
        this.injectPreviewButton(objectElement, fileName);
      }
    });
  }

  private extractS3FileName(element: Element): string | null {
    // Try different selectors to find the filename
    const selectors = [
      '[data-testid="object-name"]',
      '.object-name',
      '.filename',
      '[class*="name"]',
      'a[href*="download"]',
      'a',
      'span',
      '[role="gridcell"]',
      'td'
    ];

    for (const selector of selectors) {
      const nameElements = Array.from(element.querySelectorAll(selector));
      for (const nameElement of nameElements) {
        const text = nameElement.textContent?.trim();
        if (text && (text.endsWith('.json.gzip') || text.endsWith('.json.gz'))) {
          this.debug('Found filename via selector:', selector, text);
          return text;
        }
      }
    }

    // Fallback: look for any text that looks like a filename
    const allText = element.textContent || '';
    const fileNameMatch = allText.match(/[\w\-.]+\.(json\.gzip|json\.gz)/i);
    if (fileNameMatch) {
      this.debug('Found filename via regex:', fileNameMatch[0]);
    }
    return fileNameMatch ? fileNameMatch[0] : null;
  }

  private isGzippedJsonFile(fileName: string): boolean {
    const lowerName = fileName.toLowerCase();
    return lowerName.endsWith('.json.gzip') || lowerName.endsWith('.json.gz');
  }

  private injectPreviewButton(objectElement: Element, fileName: string): void {
    this.debug('Attempting to inject preview button for:', fileName);
    
    // Look for existing download button with valid CSS selectors only
    const downloadSelectors = [
      '[data-testid="download-button"]',
      '.download-button',
      '[class*="download"]',
      'button[data-testid*="download"]',
      'a[href*="download"]',
      // S3 object detail page selectors
      '[data-testid="object-overview-download"]',
      '[data-testid="actions-download"]',
      'button[title*="Download"]',
      'button[aria-label*="Download"]'
    ];
    
    let downloadButton: HTMLElement | null = null;
    
    // Try each selector on the object element first
    for (const selector of downloadSelectors) {
      try {
        downloadButton = objectElement.querySelector(selector) as HTMLElement;
        if (downloadButton) {
          this.debug('Found download button with selector:', selector);
          break;
        }
      } catch (error) {
        this.debug('Invalid selector:', selector, error);
        continue;
      }
    }
    
    // If not found in object element, try the whole document
    if (!downloadButton) {
      for (const selector of downloadSelectors) {
        try {
          downloadButton = document.querySelector(selector) as HTMLElement;
          if (downloadButton) {
            this.debug('Found download button in document with selector:', selector);
            break;
          }
        } catch (error) {
          this.debug('Invalid selector:', selector, error);
          continue;
        }
      }
    }
    
    // Fallback: search for buttons/links with "Download" text content
    if (!downloadButton) {
      // First try within the object element
      const localButtons = Array.from(objectElement.querySelectorAll('button, a'));
      for (const btn of localButtons) {
        if (btn.textContent?.toLowerCase().includes('download')) {
          downloadButton = btn as HTMLElement;
          this.debug('Found download button via local text content:', btn.textContent);
          break;
        }
      }
      
      // If still not found, try the whole document
      if (!downloadButton) {
        const allButtons = Array.from(document.querySelectorAll('button, a'));
        for (const btn of allButtons) {
          if (btn.textContent?.toLowerCase().includes('download')) {
            downloadButton = btn as HTMLElement;
            this.debug('Found download button via global text content:', btn.textContent);
            break;
          }
        }
      }
    }
    
    if (downloadButton && !downloadButton.parentElement?.querySelector('.dynamodb-preview-btn')) {
      this.createAndInsertPreviewButton(downloadButton, fileName);
    } else if (!downloadButton) {
      this.debug('No download button found for:', fileName);
    }
  }

  private async previewS3File(fileName: string, objectElement: Element): Promise<void> {
    try {
      this.debug('Previewing S3 file:', fileName);
      
      // Get the download URL from the download button
      const downloadButton = objectElement.querySelector('[data-testid="download-button"], .download-button, [class*="download"]') as HTMLElement;
      if (!downloadButton) {
        throw new Error('Download button not found');
      }

      const downloadUrl = this.extractDownloadUrl(downloadButton);
      if (!downloadUrl) {
        throw new Error('Download URL not found');
      }

      // Fetch the file as binary data
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }

      const binaryData = new Uint8Array(await response.arrayBuffer());
      
      // Process the gzipped data
      const decompressedData = this.decompressGzip(binaryData);
      const jsonString = new TextDecoder().decode(decompressedData);
      const parsedJson = JSON.parse(jsonString);
      const formattedJson = JSON.stringify(parsedJson, null, 2);

      // Show in preview panel
      this.showS3PreviewPanel(formattedJson, objectElement as HTMLElement, fileName);

    } catch (error) {
      this.debug('Error previewing S3 file:', error);
      this.showS3ErrorNotification(`Failed to preview ${fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async previewS3FileFromDetailPage(fileName: string, downloadButton: HTMLElement): Promise<void> {
    try {
      this.debug('Previewing S3 file from detail page:', fileName);
      
      // First try to extract URL from the button without clicking it
      let downloadUrl = this.extractDownloadUrlFromDetailPage(downloadButton);
      this.debug('URL from button extraction:', downloadUrl);
      
      // If that fails, try to extract from page context (looking for pre-signed URLs)
      if (!downloadUrl) {
        downloadUrl = this.extractUrlFromPageContext(fileName);
        this.debug('URL from page context:', downloadUrl);
      }
      
      // If we still don't have a URL, try intercepting the download request
      if (!downloadUrl) {
        downloadUrl = await this.interceptDownloadRequest(downloadButton);
        this.debug('URL from request interception:', downloadUrl);
      }
      
      // If we still don't have a URL, try constructing it (though it will likely fail with 403)
      if (!downloadUrl) {
        downloadUrl = this.constructS3DownloadUrl(fileName);
        this.debug('Constructed URL (may not have auth):', downloadUrl);
      }
      
      if (!downloadUrl) {
        throw new Error('Could not determine download URL');
      }

      await this.fetchAndDisplayS3File(downloadUrl, fileName, downloadButton);

    } catch (error) {
      this.debug('Error previewing S3 file from detail page:', error);
      this.showS3ErrorNotification(`Failed to preview ${fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async interceptDownloadRequest(downloadButton: HTMLElement): Promise<string | null> {
    return new Promise((resolve) => {
      this.debug('Attempting to intercept download request');
      
      // Store the original fetch function
      const originalFetch = window.fetch;
      let capturedUrl: string | null = null;
      let timeoutId: number;
      
      // Override fetch to capture AWS requests
      window.fetch = function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === 'string' ? input : 
                    input instanceof URL ? input.toString() : 
                    (input as Request).url;
        
        if (url.includes('amazonaws.com')) {
          capturedUrl = url;
          // Restore original fetch before resolving
          window.fetch = originalFetch;
          resolve(capturedUrl);
          // Don't actually make the request
          return Promise.reject(new Error('Request intercepted'));
        }
        
        return originalFetch.call(this, input, init);
      };
      
      // Set a timeout to restore original fetch
      timeoutId = window.setTimeout(() => {
        window.fetch = originalFetch;
        if (!capturedUrl) {
          resolve(null);
        }
      }, 2000);
      
      // Try to trigger the download
      try {
        downloadButton.click();
      } catch (error) {
        this.debug('Error clicking download button:', error);
        window.clearTimeout(timeoutId);
        window.fetch = originalFetch;
        resolve(null);
      }
    });
  }

  private extractUrlFromPageContext(fileName: string): string | null {
    this.debug('Extracting URL from page context for:', fileName);
    
    // Look for any AWS pre-signed URLs in the page that might be for our file
    const allLinks = Array.from(document.querySelectorAll('a[href*="amazonaws.com"]')) as HTMLAnchorElement[];
    for (const link of allLinks) {
      if (link.href.includes(fileName) || link.href.includes('X-Amz-')) {
        this.debug('Found potential pre-signed link:', link.href);
        return link.href;
      }
    }
    
    // Look in script tags for pre-signed URLs
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const content = script.textContent || '';
      
      // Look for pre-signed URLs with X-Amz parameters
      const preSignedMatch = content.match(/https:\/\/[^"'\s]+\.amazonaws\.com[^"'\s]*X-Amz-[^"'\s]*/g);
      if (preSignedMatch) {
        for (const url of preSignedMatch) {
          if (url.includes(fileName.replace(/\./g, '\\.'))) {
            this.debug('Found pre-signed URL in script:', url);
            return url;
          }
        }
      }
      
      // Fallback: look for any amazonaws.com URL mentioning our file
      const urlMatch = content.match(new RegExp(`https://[^\\s"']+amazonaws\\.com[^\\s"']*${fileName.replace('.', '\\.')}[^\\s"']*`, 'g'));
      if (urlMatch && urlMatch.length > 0) {
        this.debug('Found AWS URL in script:', urlMatch[0]);
        return urlMatch[0];
      }
    }
    
    // Look for URLs in data attributes across the page
    const elementsWithData = Array.from(document.querySelectorAll('[data-*]'));
    for (const element of elementsWithData) {
      const dataset = (element as HTMLElement).dataset;
      for (const key in dataset) {
        const value = dataset[key];
        if (value && value.includes('amazonaws.com') && value.includes(fileName)) {
          this.debug('Found URL in data attribute:', value);
          return value;
        }
      }
    }
    
    // Look for URLs in the page HTML as last resort
    const pageContent = document.documentElement.outerHTML;
    const preSignedMatch = pageContent.match(/https:\/\/[^"'\s]+\.amazonaws\.com[^"'\s]*X-Amz-[^"'\s]*/g);
    if (preSignedMatch) {
      for (const url of preSignedMatch) {
        if (url.includes(fileName.replace(/\./g, '\\.'))) {
          this.debug('Found pre-signed URL in page content:', url);
          return url;
        }
      }
    }
    
    return null;
  }

  private async captureDownloadUrl(downloadButton: HTMLElement): Promise<string | null> {
    return new Promise((resolve) => {
      this.debug('Attempting to capture download URL by intercepting click');
      
      // Store original functions
      const originalWindowOpen = window.open;
      
      let capturedUrl: string | null = null;
      let timeoutId: number;
      
      // Override window.open to capture the URL
      window.open = function(url?: string | URL): Window | null {
        if (url) {
          capturedUrl = url.toString();
          resolve(capturedUrl);
        }
        return null;
      };
      
      // Set a timeout to restore original functions
      timeoutId = window.setTimeout(() => {
        window.open = originalWindowOpen;
        if (!capturedUrl) {
          resolve(null);
        }
      }, 1000);
      
      // Simulate click on the download button
      try {
        downloadButton.click();
      } catch (error) {
        this.debug('Error clicking download button:', error);
        window.clearTimeout(timeoutId);
        window.open = originalWindowOpen;
        resolve(null);
      }
    });
  }

  private extractDownloadUrlFromDetailPage(downloadButton: HTMLElement): string | null {
    this.debug('Extracting download URL from button:', downloadButton);
    this.debug('Button tagName:', downloadButton.tagName);
    this.debug('Button attributes:', downloadButton.attributes);
    this.debug('Button innerHTML:', downloadButton.innerHTML);
    
    // Try various methods to get the download URL
    if (downloadButton.tagName === 'A') {
      const href = (downloadButton as HTMLAnchorElement).href;
      this.debug('Found href on anchor:', href);
      return href;
    }

    // Look for onclick handler or data attributes
    const onclick = downloadButton.getAttribute('onclick');
    this.debug('Button onclick:', onclick);
    if (onclick) {
      const urlMatch = onclick.match(/https?:\/\/[^\s'",)]+/);
      if (urlMatch) {
        this.debug('Found URL in onclick:', urlMatch[0]);
        return urlMatch[0];
      }
    }

    // Look for data attributes
    const dataUrl = downloadButton.dataset.url || downloadButton.dataset.href;
    this.debug('Button data attributes:', downloadButton.dataset);
    if (dataUrl) {
      this.debug('Found data URL:', dataUrl);
      return dataUrl;
    }

    // Check all attributes for URLs
    for (let i = 0; i < downloadButton.attributes.length; i++) {
      const attr = downloadButton.attributes[i];
      if (attr.value.match(/https?:\/\//)) {
        this.debug('Found URL in attribute', attr.name, attr.value);
        return attr.value;
      }
    }

    // Look for parent or child elements with URLs
    const parentElement = downloadButton.parentElement;
    if (parentElement) {
      const parentLink = parentElement.querySelector('a[href]') as HTMLAnchorElement;
      if (parentLink) {
        this.debug('Found parent link:', parentLink.href);
        return parentLink.href;
      }
    }

    // Check if the button has a form action
    const form = downloadButton.closest('form') as HTMLFormElement;
    if (form?.action) {
      this.debug('Found form action:', form.action);
      return form.action;
    }

    this.debug('No download URL found in button');
    return null;
  }

  private constructS3DownloadUrl(fileName: string): string | null {
    this.debug('Constructing S3 download URL for:', fileName);
    this.debug('Current URL:', window.location.href);
    
    const url = new URL(window.location.href);
    const pathParts = url.pathname.split('/').filter(part => part.length > 0);
    const urlParams = new URLSearchParams(url.search);
    
    this.debug('URL path parts:', pathParts);
    
    // Convert URLSearchParams to object for debugging (compatible with older TypeScript)
    const paramsObj: { [key: string]: string } = {};
    urlParams.forEach((value, key) => {
      paramsObj[key] = value;
    });
    this.debug('URL params:', paramsObj);
    
    // Find bucket name in the path or params
    let bucketIndex = pathParts.indexOf('buckets');
    if (bucketIndex === -1) {
      bucketIndex = pathParts.indexOf('bucket');
    }
    
    let bucketName = '';
    let objectKey = fileName;
    
    if (bucketIndex !== -1 && bucketIndex + 1 < pathParts.length) {
      bucketName = pathParts[bucketIndex + 1];
      this.debug('Found bucket name from path:', bucketName);
    } else {
      // Try to extract bucket name from URL params or other sources
      const bucketParam = urlParams.get('bucket');
      if (bucketParam) {
        bucketName = bucketParam;
        this.debug('Found bucket name from params:', bucketName);
      }
    }
    
    if (!bucketName) {
      this.debug('Could not determine bucket name');
      return null;
    }
    
    // Determine the object key (full path to the file)
    const prefix = urlParams.get('prefix');
    if (prefix) {
      if (prefix.endsWith(fileName)) {
        objectKey = prefix;
      } else {
        objectKey = prefix.endsWith('/') ? prefix + fileName : prefix + '/' + fileName;
      }
      this.debug('Using prefix-based object key:', objectKey);
    } else {
      // Try to get object key from the URL path after bucket
      if (bucketIndex !== -1 && bucketIndex + 2 < pathParts.length) {
        const pathAfterBucket = pathParts.slice(bucketIndex + 2);
        if (pathAfterBucket.length > 0) {
          objectKey = pathAfterBucket.join('/');
          if (!objectKey.endsWith(fileName)) {
            objectKey = objectKey.endsWith('/') ? objectKey + fileName : objectKey + '/' + fileName;
          }
          this.debug('Constructed object key from path:', objectKey);
        }
      }
    }
    
    // Extract region from URL
    const region = this.extractRegionFromUrl() || 'us-east-1';
    this.debug('Using region:', region);
    
    // Construct the S3 URL
    const constructedUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${encodeURIComponent(objectKey)}`;
    this.debug('Final constructed URL:', constructedUrl);
    
    return constructedUrl;
  }

  private extractRegionFromUrl(): string | null {
    // Try multiple methods to extract region
    const url = new URL(window.location.href);
    
    // Method 1: From hostname
    const regionMatch = url.hostname.match(/\.([^.]+)\.console\.aws\.amazon\.com/);
    if (regionMatch) {
      this.debug('Found region from hostname:', regionMatch[1]);
      return regionMatch[1];
    }
    
    // Method 2: From URL path
    const pathMatch = url.pathname.match(/\/([^\/]+)\/s3/);
    if (pathMatch) {
      this.debug('Found region from path:', pathMatch[1]);
      return pathMatch[1];
    }
    
    // Method 3: From URL params
    const urlParams = new URLSearchParams(url.search);
    const regionParam = urlParams.get('region');
    if (regionParam) {
      this.debug('Found region from params:', regionParam);
      return regionParam;
    }
    
    this.debug('Could not determine region, using default');
    return null;
  }

  private async fetchAndDisplayS3File(downloadUrl: string, fileName: string, anchorElement: HTMLElement): Promise<void> {
    this.debug('Fetching S3 file from URL:', downloadUrl);
    
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }

    const binaryData = new Uint8Array(await response.arrayBuffer());
    
    // Process the gzipped data
    const decompressedData = this.decompressGzip(binaryData);
    const jsonString = new TextDecoder().decode(decompressedData);
    const parsedJson = JSON.parse(jsonString);
    const formattedJson = JSON.stringify(parsedJson, null, 2);

    // Show in preview panel
    this.showS3PreviewPanel(formattedJson, anchorElement, fileName);
  }

  private extractDownloadUrl(downloadButton: HTMLElement): string | null {
    // Try to get URL from href attribute
    if (downloadButton.tagName === 'A') {
      return (downloadButton as HTMLAnchorElement).href;
    }

    // Look for parent link
    const parentLink = downloadButton.closest('a[href]') as HTMLAnchorElement;
    if (parentLink) {
      return parentLink.href;
    }

    // Look for data attributes
    const dataUrl = downloadButton.dataset.url || downloadButton.dataset.href;
    if (dataUrl) {
      return dataUrl;
    }

    // Fallback: try to trigger click and capture the URL (more complex)
    return null;
  }

  private showS3PreviewPanel(content: string, anchorElement: HTMLElement, fileName: string): void {
    if (!this._previewPanel) return;

    // Update panel title for S3
    const titleElement = this._previewPanel.element.querySelector('span');
    if (titleElement) {
      titleElement.textContent = `Preview: ${fileName}`;
    }

    this._previewPanel.content.textContent = content;
    this._previewPanel.isVisible = true;
    this._previewPanel.element.style.display = 'block';

    // Position relative to the object row
    this.positionS3Panel(anchorElement);

    // Set up copy functionality
    this._previewPanel.copyButton.onclick = (): void => {
      this.copyToClipboard(content);
      this.showCopyFeedback();
    };
  }

  private positionS3Panel(anchorElement: HTMLElement): void {
    if (!this._previewPanel) return;

    const rect = anchorElement.getBoundingClientRect();
    const panel = this._previewPanel.element;
    
    // Position to the right of the element, or left if no space
    let left = rect.right + 10;
    let top = rect.top;

    // Check if panel would go off-screen
    if (left + 500 > window.innerWidth) {
      left = rect.left - 510; // Position to the left
    }

    // Ensure panel doesn't go below viewport
    if (top + 400 > window.innerHeight) {
      top = window.innerHeight - 400 - 10;
    }

    // Ensure panel doesn't go above viewport
    if (top < 10) {
      top = 10;
    }

    panel.style.left = `${Math.max(10, left)}px`;
    panel.style.top = `${top}px`;
  }

  private showS3ErrorNotification(message: string): void {
    // Create a temporary error notification
    const notification = document.createElement('div');
    notification.textContent = message;
    
    const theme = this.detectAWSTheme();
    const styles = this.getThemeStyles(theme);
    
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${styles.errorText};
      color: white;
      padding: 12px 16px;
      border-radius: 4px;
      z-index: 10001;
      font-size: 14px;
      max-width: 400px;
    `;

    document.body.appendChild(notification);

    // Remove after 5 seconds
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 5000);
  }
}

new PayloadFormatter();