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
  private readonly _mouseMoveThrottle = 100;
  private _debugMode = true;
  private _observedElements = new Set<HTMLElement>();

  constructor() {
    this.attachEventListeners();
    this.registerMessageHandler();
    this.createPreviewPanel();
    this.initializeS3Support();
    
    if ((window as unknown as { dynamoDBFormatterDebug?: boolean }).dynamoDBFormatterDebug) {
      this._debugMode = true;
    }
    
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

    if (this.isInDynamoDBConsole()) {
      document.addEventListener('mousemove', this.handleMouseMove.bind(this), true);
    }
  
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

    document.addEventListener('click', (event) => {
      if (this._previewPanel?.isVisible && !this._previewPanel.element.contains(event.target as Node)) {
        this.hidePreviewPanel();
      }
    });

    panel.addEventListener('mouseenter', () => {
      if (this._hoverTimeout) {
        clearTimeout(this._hoverTimeout);
        this._hoverTimeout = null;
      }
    });
  }

  private detectAWSTheme(): 'light' | 'dark' {
    const body = document.body;
    const html = document.documentElement;
    
    if (body.dataset.theme === 'dark' || html.dataset.theme === 'dark') {
      return 'dark';
    }
    
    if (body.classList.contains('awsui-dark-mode') || html.classList.contains('awsui-dark-mode')) {
      return 'dark';
    }
    
    const mainElement = document.querySelector('main') || document.querySelector('[data-testid="main-content"]') || body;
    const computedStyle = window.getComputedStyle(mainElement);
    const backgroundColor = computedStyle.backgroundColor;
    
    const rgbMatch = backgroundColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      const [, r, g, b] = rgbMatch.map(Number);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.5 ? 'dark' : 'light';
    }
    
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
  
    if (now - this._lastMouseMoveTime < this._mouseMoveThrottle) {
      return;
    }
    this._lastMouseMoveTime = now;
  
    if (target.tagName === 'TEXTAREA' && this.isInDynamoDBConsole()) {
      if (this._currentHoveredTextarea !== target) {
        this.startHoverTimer(target as HTMLTextAreaElement);
      }
    } else {
      const isOverPreviewPanel = this._previewPanel?.element.contains(target);
      
      if (!isOverPreviewPanel && this._currentHoveredTextarea !== null) {
        this._currentHoveredTextarea = null;
        this.clearHoverTimer();
        
        setTimeout(() => {
          if (!this._previewPanel?.element.matches(':hover')) {
            this.hidePreviewPanel();
          }
        }, 100);
      }
    }
  }

  private startHoverTimer(textarea: HTMLTextAreaElement): void {
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
      
      if (this._currentHoveredTextarea === target) {
        this._currentHoveredTextarea = null;
      }

      this.clearHoverTimer();

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
    
    return (
      path.includes('/object/') ||
      search.includes('prefix=') ||
      search.includes('tab=overview') ||
      search.includes('tab=properties') ||
      url.includes('&prefix=') ||
      document.title.includes('Object overview') ||
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.test(url) ||
      /\.json\.gz/.test(url) ||
      /\.json\.gzip/.test(url)
    );
  }

  private handleS3ObjectDetailPage(): void {
    this.debug('Handling S3 object detail page');
    
    if (document.querySelector('.dynamodb-preview-btn')) {
      this.debug('Preview button already exists, skipping');
      return;
    }
    
    const fileName = this.extractS3FileNameFromPage();
    if (fileName && this.isGzippedJsonFile(fileName)) {
      this.debug('Found gzipped JSON file on detail page:', fileName);
      this.injectPreviewButtonOnDetailPage(fileName);
    } else {
      this.debug('No valid gzipped JSON file found on detail page. Filename:', fileName);
    }
  }

  private extractS3FileNameFromPage(): string | null {
    const urlParts = window.location.pathname.split('/');
    const lastPart = urlParts[urlParts.length - 1];
    if (lastPart && (lastPart.endsWith('.json.gzip') || lastPart.endsWith('.json.gz'))) {
      return decodeURIComponent(lastPart);
    }

    const urlParams = new URLSearchParams(window.location.search);
    const prefix = urlParams.get('prefix');
    if (prefix && (prefix.endsWith('.json.gzip') || prefix.endsWith('.json.gz'))) {
      return prefix;
    }

    const titleMatch = document.title.match(/([^/]+\.(json\.gzip|json\.gz))/i);
    if (titleMatch) {
      return titleMatch[1];
    }

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
      await this.previewS3FileFromDetailPageWithFallback(fileName, downloadButton);
    });

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
    
    let left = rect.right + 10;
    let top = rect.top;

    if (left + 500 > window.innerWidth) {
      left = rect.left - 510;
    }

    if (top + 400 > window.innerHeight) {
      top = window.innerHeight - 400 - 10;
    }

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
    
    if (this.isS3ObjectDetailPage()) {
      this.debug('Detected S3 object detail page');
      setTimeout(() => this.handleS3ObjectDetailPage(), 500);
      setTimeout(() => this.handleS3ObjectDetailPage(), 1500);
      setTimeout(() => this.handleS3ObjectDetailPage(), 3000);
    }
    
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
    
    setInterval(checkUrlChange, 1000);
    
    const observer = new MutationObserver((mutations) => {
      try {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
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

    this.processS3Elements(document.body);
  }

  private processS3Elements(element: Element): void {
    this.debug('Processing S3 elements in:', element.tagName, element.className);
    
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
    
    const downloadSelectors = [
      '[data-testid="download-button"]',
      '.download-button',
      '[class*="download"]',
      'button[data-testid*="download"]',
      'a[href*="download"]',
      '[data-testid="object-overview-download"]',
      '[data-testid="actions-download"]',
      'button[title*="Download"]',
      'button[aria-label*="Download"]'
    ];
    
    let downloadButton: HTMLElement | null = null;
    
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
    
    if (!downloadButton) {
      const localButtons = Array.from(objectElement.querySelectorAll('button, a'));
      for (const btn of localButtons) {
        if (btn.textContent?.toLowerCase().includes('download')) {
          downloadButton = btn as HTMLElement;
          this.debug('Found download button via local text content:', btn.textContent);
          break;
        }
      }
      
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

  // Updated S3 preview methods using blob interception
  private async previewS3FileFromDetailPageWithFallback(fileName: string, downloadButton: HTMLElement): Promise<void> {
    try {
      this.debug('Previewing S3 file from detail page:', fileName);
      
      // First try the blob interception approach
      const fileContent = await this.interceptDownloadBlob(downloadButton, fileName);
      
      if (fileContent) {
        const decompressedData = this.decompressGzip(fileContent);
        const jsonString = new TextDecoder().decode(decompressedData);
        const parsedJson = JSON.parse(jsonString);
        const formattedJson = JSON.stringify(parsedJson, null, 2);
        
        this.showS3PreviewPanel(formattedJson, downloadButton, fileName);
        return;
      }
      
      // If blob interception fails, offer file input fallback
      this.showFallbackDialog(fileName, downloadButton);
      
    } catch (error) {
      this.debug('Error in primary preview method:', error);
      this.showFallbackDialog(fileName, downloadButton);
    }
  }

  private async interceptDownloadBlob(downloadButton: HTMLElement, fileName: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      this.debug('Intercepting download blob for:', fileName);
      
      // Store original link creation
      const originalCreateElement = document.createElement;
      let blobUrl: string | null = null;
      let interceptedBlob: Blob | null = null;
      
      // Override createElement to catch blob downloads
      document.createElement = function(tagName: string): HTMLElement {
        const element = originalCreateElement.call(document, tagName);
        
        if (tagName.toLowerCase() === 'a') {
          const anchor = element as HTMLAnchorElement;
          const originalSetAttribute = anchor.setAttribute;
          
          anchor.setAttribute = function(name: string, value: string) {
            if (name === 'href' && value.startsWith('blob:')) {
              blobUrl = value;
              console.debug('Intercepted blob URL:', blobUrl);
              
              // Get the blob from the URL
              fetch(blobUrl)
                .then(response => response.blob())
                .then(blob => {
                  interceptedBlob = blob;
                  console.debug('Successfully intercepted blob, size:', blob.size);
                })
                .catch(error => {
                  console.debug('Error fetching blob:', error);
                });
            }
            return originalSetAttribute.call(this, name, value);
          };
        }
        
        return element;
      };
      
      // Also intercept URL.createObjectURL
      const originalCreateObjectURL = URL.createObjectURL;
      URL.createObjectURL = function(object: Blob | MediaSource): string {
        const url = originalCreateObjectURL.call(this, object);
        
        if (object instanceof Blob) {
          interceptedBlob = object;
          console.debug('Intercepted blob via createObjectURL, size:', object.size);
        }
        
        return url;
      };
      
      // Set up cleanup
      const cleanup = () => {
        document.createElement = originalCreateElement;
        URL.createObjectURL = originalCreateObjectURL;
      };
      
      // Set timeout
      const timeoutId = setTimeout(async () => {
        cleanup();
        
        if (interceptedBlob) {
          try {
            const arrayBuffer = await interceptedBlob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            console.debug('Successfully converted blob to Uint8Array, size:', uint8Array.length);
            resolve(uint8Array);
          } catch (error) {
            console.debug('Error converting blob to Uint8Array:', error);
            resolve(null);
          }
        } else {
          console.debug('No blob intercepted');
          resolve(null);
        }
      }, 3000);
      
      // Trigger the download
      try {
        // Create a more natural click event
        const clickEvent = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          detail: 1,
          screenX: 0,
          screenY: 0,
          clientX: 0,
          clientY: 0,
          button: 0,
          buttons: 1
        });
        
        downloadButton.dispatchEvent(clickEvent);
        
        // Also try direct click
        if (downloadButton.click) {
          setTimeout(() => downloadButton.click(), 100);
        }
        
      } catch (error) {
        this.debug('Error triggering download:', error);
        cleanup();
        clearTimeout(timeoutId);
        resolve(null);
      }
    });
  }

  private async previewS3File(fileName: string, objectElement: Element): Promise<void> {
    try {
      this.debug('Previewing S3 file:', fileName);
      
      const downloadButton = objectElement.querySelector('[data-testid="download-button"], .download-button, [class*="download"]') as HTMLElement;
      if (!downloadButton) {
        throw new Error('Download button not found');
      }

      // Use blob interception instead of URL fetching
      const fileContent = await this.interceptDownloadBlob(downloadButton, fileName);
      
      if (!fileContent) {
        throw new Error('Could not intercept file download');
      }

      const decompressedData = this.decompressGzip(fileContent);
      const jsonString = new TextDecoder().decode(decompressedData);
      const parsedJson = JSON.parse(jsonString);
      const formattedJson = JSON.stringify(parsedJson, null, 2);

      this.showS3PreviewPanel(formattedJson, objectElement as HTMLElement, fileName);

    } catch (error) {
      this.debug('Error previewing S3 file:', error);
      this.showS3ErrorNotification(`Failed to preview ${fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private createFileInputFallback(fileName: string, downloadButton: HTMLElement): void {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.gz,.gzip,.json.gz,.json.gzip';
    fileInput.style.display = 'none';
    
    fileInput.addEventListener('change', async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          
          // Try to decompress and parse
          const decompressedData = this.decompressGzip(uint8Array);
          const jsonString = new TextDecoder().decode(decompressedData);
          const parsedJson = JSON.parse(jsonString);
          const formattedJson = JSON.stringify(parsedJson, null, 2);
          
          this.showS3PreviewPanel(formattedJson, downloadButton, file.name);
          
        } catch (error) {
          this.showS3ErrorNotification(`Failed to process file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      
      // Clean up
      document.body.removeChild(fileInput);
    });
    
    document.body.appendChild(fileInput);
    fileInput.click();
  }

  private showFallbackDialog(fileName: string, downloadButton: HTMLElement): void {
    const dialog = document.createElement('div');
    const theme = this.detectAWSTheme();
    const styles = this.getThemeStyles(theme);
    
    dialog.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: ${styles.background};
      color: ${styles.text};
      border: 1px solid ${styles.border};
      border-radius: 8px;
      padding: 20px;
      z-index: 10001;
      box-shadow: 0 10px 25px ${styles.shadow};
      max-width: 400px;
    `;
    
    dialog.innerHTML = `
      <h3 style="margin: 0 0 15px 0; font-size: 16px;">Preview ${fileName}</h3>
      <p style="margin: 0 0 15px 0; font-size: 14px; line-height: 1.4;">
        The file couldn't be previewed directly. You can:
      </p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button id="download-first" style="
          background: ${styles.buttonBg};
          color: ${styles.buttonText};
          border: none;
          border-radius: 4px;
          padding: 8px 16px;
          cursor: pointer;
          font-size: 14px;
        ">Download & Preview</button>
        <button id="select-file" style="
          background: transparent;
          color: ${styles.text};
          border: 1px solid ${styles.border};
          border-radius: 4px;
          padding: 8px 16px;
          cursor: pointer;
          font-size: 14px;
        ">Select Downloaded File</button>
        <button id="cancel-dialog" style="
          background: transparent;
          color: ${styles.textSecondary};
          border: none;
          border-radius: 4px;
          padding: 8px 16px;
          cursor: pointer;
          font-size: 14px;
        ">Cancel</button>
      </div>
    `;
    
    document.body.appendChild(dialog);
    
    // Add event listeners
    dialog.querySelector('#download-first')?.addEventListener('click', () => {
      downloadButton.click();
      document.body.removeChild(dialog);
      
      // Show instructions
      setTimeout(() => {
        this.showInstructions(fileName, downloadButton);
      }, 1000);
    });
    
    dialog.querySelector('#select-file')?.addEventListener('click', () => {
      document.body.removeChild(dialog);
      this.createFileInputFallback(fileName, downloadButton);
    });
    
    dialog.querySelector('#cancel-dialog')?.addEventListener('click', () => {
      document.body.removeChild(dialog);
    });
    
    // Close on outside click
    const closeOnOutsideClick = (event: Event) => {
      if (!dialog.contains(event.target as Node)) {
        document.body.removeChild(dialog);
        document.removeEventListener('click', closeOnOutsideClick, true);
      }
    };
    
    setTimeout(() => {
      document.addEventListener('click', closeOnOutsideClick, true);
    }, 100);
  }

  private showInstructions(fileName: string, downloadButton: HTMLElement): void {
    const notification = document.createElement('div');
    const theme = this.detectAWSTheme();
    const styles = this.getThemeStyles(theme);
    
    notification.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${styles.background};
      color: ${styles.text};
      border: 1px solid ${styles.border};
      border-radius: 8px;
      padding: 16px;
      z-index: 10001;
      max-width: 350px;
      box-shadow: 0 4px 12px ${styles.shadow};
    `;
    
    notification.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 8px;">File Downloaded</div>
      <div style="font-size: 14px; margin-bottom: 12px;">
        Once the download completes, click the "Select Downloaded File" button to preview it.
      </div>
      <button id="select-downloaded" style="
        background: ${styles.buttonBg};
        color: ${styles.buttonText};
        border: none;
        border-radius: 4px;
        padding: 6px 12px;
        cursor: pointer;
        font-size: 12px;
        margin-right: 8px;
      ">Select Downloaded File</button>
      <button id="dismiss-notification" style="
        background: transparent;
        color: ${styles.textSecondary};
        border: none;
        border-radius: 4px;
        padding: 6px 12px;
        cursor: pointer;
        font-size: 12px;
      ">Dismiss</button>
    `;
    
    document.body.appendChild(notification);
    
    notification.querySelector('#select-downloaded')?.addEventListener('click', () => {
      document.body.removeChild(notification);
      this.createFileInputFallback(fileName, downloadButton);
    });
    
    notification.querySelector('#dismiss-notification')?.addEventListener('click', () => {
      document.body.removeChild(notification);
    });
    
    // Auto-dismiss after 10 seconds
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 10000);
  }

  private showS3PreviewPanel(content: string, anchorElement: HTMLElement, fileName: string): void {
    if (!this._previewPanel) return;

    const titleElement = this._previewPanel.element.querySelector('span');
    if (titleElement) {
      titleElement.textContent = `Preview: ${fileName}`;
    }

    this._previewPanel.content.textContent = content;
    this._previewPanel.isVisible = true;
    this._previewPanel.element.style.display = 'block';

    this.positionS3Panel(anchorElement);

    this._previewPanel.copyButton.onclick = (): void => {
      this.copyToClipboard(content);
      this.showCopyFeedback();
    };
  }

  private positionS3Panel(anchorElement: HTMLElement): void {
    if (!this._previewPanel) return;

    const rect = anchorElement.getBoundingClientRect();
    const panel = this._previewPanel.element;
    
    let left = rect.right + 10;
    let top = rect.top;

    if (left + 500 > window.innerWidth) {
      left = rect.left - 510;
    }

    if (top + 400 > window.innerHeight) {
      top = window.innerHeight - 400 - 10;
    }

    if (top < 10) {
      top = 10;
    }

    panel.style.left = `${Math.max(10, left)}px`;
    panel.style.top = `${top}px`;
  }

  private showS3ErrorNotification(message: string): void {
    const notification = document.createElement('div');
    notification.textContent = message;
    
    const theme = this.detectAWSTheme();
    const styles = this.getThemeStyles(theme);
    
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #e53e3e;
      color: white;
      padding: 12px 16px;
      border-radius: 4px;
      z-index: 10001;
      font-size: 14px;
      max-width: 400px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 5000);
  }
}

new PayloadFormatter();