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
      await this.previewS3FileFromDetailPage(fileName, downloadButton);
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

  private async previewS3File(fileName: string, objectElement: Element): Promise<void> {
    try {
      this.debug('Previewing S3 file:', fileName);
      
      const downloadButton = objectElement.querySelector('[data-testid="download-button"], .download-button, [class*="download"]') as HTMLElement;
      if (!downloadButton) {
        throw new Error('Download button not found');
      }

      const downloadUrl = this.extractDownloadUrl(downloadButton);
      if (!downloadUrl) {
        throw new Error('Download URL not found');
      }

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }

      const binaryData = new Uint8Array(await response.arrayBuffer());
      
      const decompressedData = this.decompressGzip(binaryData);
      const jsonString = new TextDecoder().decode(decompressedData);
      const parsedJson = JSON.parse(jsonString);
      const formattedJson = JSON.stringify(parsedJson, null, 2);

      this.showS3PreviewPanel(formattedJson, objectElement as HTMLElement, fileName);

    } catch (error) {
      this.debug('Error previewing S3 file:', error);
      this.showS3ErrorNotification(`Failed to preview ${fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async previewS3FileFromDetailPage(fileName: string, downloadButton: HTMLElement): Promise<void> {
    try {
      this.debug('Previewing S3 file from detail page:', fileName);
      
      // First try to get the authenticated download URL by triggering the download request
      const downloadUrl = await this.getAuthenticatedDownloadUrl(downloadButton, fileName);
      
      if (!downloadUrl) {
        throw new Error('Could not obtain authenticated download URL. The file may require special permissions or the AWS console interface may have changed.');
      }

      await this.fetchAndDisplayS3File(downloadUrl, fileName, downloadButton);

    } catch (error) {
      this.debug('Error previewing S3 file from detail page:', error);
      this.showS3ErrorNotification(`Failed to preview ${fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getAuthenticatedDownloadUrl(downloadButton: HTMLElement, fileName: string): Promise<string | null> {
    this.debug('Getting authenticated download URL');
    this.debug('Download button:', downloadButton);
    this.debug('Download button HTML:', downloadButton.outerHTML);
    
    // Method 1: Deep inspection of the download button and its properties
    let downloadUrl = await this.extractUrlFromDownloadButton(downloadButton);
    if (downloadUrl) {
      this.debug('Found URL from download button inspection:', downloadUrl);
      return downloadUrl;
    }
    
    // Method 2: Try to intercept network requests when the download button is clicked
    downloadUrl = await this.interceptDownloadRequest(downloadButton);
    if (downloadUrl) {
      this.debug('Intercepted download URL:', downloadUrl);
      return downloadUrl;
    }
    
    // Method 3: Look for pre-signed URLs in the page context
    downloadUrl = this.extractUrlFromPageContext(fileName);
    if (downloadUrl) {
      this.debug('Found URL in page context:', downloadUrl);
      return downloadUrl;
    }
    
    // Method 4: Try to simulate the download and capture the URL
    downloadUrl = await this.simulateDownloadAndCaptureUrl(downloadButton);
    if (downloadUrl) {
      this.debug('Captured URL from simulated download:', downloadUrl);
      return downloadUrl;
    }
    
    this.debug('Could not find authenticated download URL');
    return null;
  }

  private async extractUrlFromDownloadButton(downloadButton: HTMLElement): Promise<string | null> {
    this.debug('Deep inspection of download button');
    
    // Check if it's an anchor with href
    if (downloadButton.tagName === 'A') {
      const href = (downloadButton as HTMLAnchorElement).href;
      if (href && href.includes('amazonaws.com')) {
        this.debug('Found href on anchor:', href);
        return href;
      }
    }
    
    // Check all attributes for URLs
    for (let i = 0; i < downloadButton.attributes.length; i++) {
      const attr = downloadButton.attributes[i];
      const value = attr.value;
      if (value && value.includes('amazonaws.com')) {
        this.debug('Found AWS URL in attribute', attr.name, ':', value);
        return value;
      }
    }
    
    // Check data attributes specifically
    const dataset = (downloadButton as HTMLElement).dataset;
    for (const key in dataset) {
      const value = dataset[key];
      if (value && value.includes('amazonaws.com')) {
        this.debug('Found AWS URL in dataset', key, ':', value);
        return value;
      }
    }
    
    // Check onclick handler for URLs
    const onclick = downloadButton.getAttribute('onclick');
    if (onclick) {
      this.debug('Onclick handler:', onclick);
      // Look for AWS URLs in the onclick
      const awsUrlMatch = onclick.match(/https:\/\/[^'"\s,)]+\.amazonaws\.com[^'"\s,)]*/g);
      if (awsUrlMatch) {
        this.debug('Found AWS URL in onclick:', awsUrlMatch[0]);
        return awsUrlMatch[0];
      }
    }
    
    // Check for JavaScript properties that might contain the URL
    const buttonAny = downloadButton as any;
    const propsToCheck = ['downloadUrl', 'url', 'href', 'src', 'action', 'formAction'];
    for (const prop of propsToCheck) {
      if (buttonAny[prop] && typeof buttonAny[prop] === 'string' && buttonAny[prop].includes('amazonaws.com')) {
        this.debug('Found AWS URL in property', prop, ':', buttonAny[prop]);
        return buttonAny[prop];
      }
    }
    
    // Check parent elements
    let parent = downloadButton.parentElement;
    let depth = 0;
    while (parent && depth < 5) {
      if (parent.tagName === 'A') {
        const href = (parent as HTMLAnchorElement).href;
        if (href && href.includes('amazonaws.com')) {
          this.debug('Found AWS URL in parent anchor:', href);
          return href;
        }
      }
      
      // Check parent's onclick
      const parentOnclick = parent.getAttribute('onclick');
      if (parentOnclick) {
        const awsUrlMatch = parentOnclick.match(/https:\/\/[^'"\s,)]+\.amazonaws\.com[^'"\s,)]*/g);
        if (awsUrlMatch) {
          this.debug('Found AWS URL in parent onclick:', awsUrlMatch[0]);
          return awsUrlMatch[0];
        }
      }
      
      parent = parent.parentElement;
      depth++;
    }
    
    // Check if the button is inside a form
    const form = downloadButton.closest('form') as HTMLFormElement;
    if (form) {
      if (form.action && form.action.includes('amazonaws.com')) {
        this.debug('Found AWS URL in form action:', form.action);
        return form.action;
      }
      
      // Check form's data attributes
      const formDataset = (form as HTMLElement).dataset;
      for (const key in formDataset) {
        const value = formDataset[key];
        if (value && value.includes('amazonaws.com')) {
          this.debug('Found AWS URL in form dataset', key, ':', value);
          return value;
        }
      }
    }
    
    // Look for any AWS URLs in nearby text or hidden inputs
    const container = downloadButton.closest('[class*="download"], [class*="action"], [class*="button"]') || downloadButton.parentElement;
    if (container) {
      const hiddenInputs = Array.from(container.querySelectorAll('input[type="hidden"]'));
      for (const input of hiddenInputs) {
        const value = (input as HTMLInputElement).value;
        if (value && value.includes('amazonaws.com')) {
          this.debug('Found AWS URL in hidden input:', value);
          return value;
        }
      }
    }
    
    this.debug('No AWS URL found in download button inspection');
    return null;
  }

  private async simulateDownloadAndCaptureUrl(downloadButton: HTMLElement): Promise<string | null> {
    return new Promise((resolve) => {
      this.debug('Simulating download to capture URL');
      
      // Create a more comprehensive network interceptor
      const originalFetch = window.fetch;
      const originalXHROpen = XMLHttpRequest.prototype.open;
      const originalXHRSend = XMLHttpRequest.prototype.send;
      const originalWindowOpen = window.open;
      const originalAssign = window.location.assign;
      const originalReplace = window.location.replace;
      
      let capturedUrl: string | null = null;
      let timeoutId: number;
      
      const restoreOriginals = () => {
        window.fetch = originalFetch;
        XMLHttpRequest.prototype.open = originalXHROpen;
        XMLHttpRequest.prototype.send = originalXHRSend;
        window.open = originalWindowOpen;
        window.location.assign = originalAssign;
        window.location.replace = originalReplace;
      };
      
      const captureUrl = (url: string) => {
        if (url.includes('amazonaws.com')) {
          capturedUrl = url;
          this.debug('Captured URL:', url);
          restoreOriginals();
          resolve(capturedUrl);
        }
      };
      
      // Override fetch
      window.fetch = function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === 'string' ? input : 
                    input instanceof URL ? input.toString() : 
                    (input as Request).url;
        
        captureUrl(url);
        return originalFetch.call(this, input, init);
      };
      
      // Override XMLHttpRequest
      XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null): void {
        captureUrl(url.toString());
        return originalXHROpen.call(this, method, url, async, username, password);
      };
      
      // Override window.open
      window.open = function(url?: string | URL): Window | null {
        if (url) {
          captureUrl(url.toString());
        }
        return null; // Don't actually open the window
      };
      
      // Override location methods
      window.location.assign = function(url: string): void {
        captureUrl(url);
      };
      
      window.location.replace = function(url: string): void {
        captureUrl(url);
      };
      
      // Set timeout
      timeoutId = window.setTimeout(() => {
        restoreOriginals();
        resolve(capturedUrl);
      }, 2000);
      
      // Try multiple ways to trigger the download
      try {
        // Method 1: Direct click
        downloadButton.click();
        
        // Method 2: Dispatch events
        window.setTimeout(() => {
          const events = ['mousedown', 'mouseup', 'click'];
          for (const eventType of events) {
            try {
              const event = new MouseEvent(eventType, {
                bubbles: true,
                cancelable: true,
                view: window
              });
              downloadButton.dispatchEvent(event);
            } catch (e) {
              this.debug('Error dispatching event:', e);
            }
          }
        }, 100);
        
        // Method 3: Try to call onclick directly
        window.setTimeout(() => {
          if (downloadButton.onclick) {
            try {
              const clickEvent = new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
              });
              downloadButton.onclick(clickEvent);
            } catch (e) {
              this.debug('Error calling onclick directly:', e);
            }
          }
        }, 200);
        
        // Method 4: Try to submit parent form if exists
        window.setTimeout(() => {
          const form = downloadButton.closest('form') as HTMLFormElement;
          if (form) {
            try {
              // Don't actually submit, just see if it triggers any network calls
              const submitEvent = new Event('submit', {
                bubbles: true,
                cancelable: true
              });
              form.dispatchEvent(submitEvent);
            } catch (e) {
              this.debug('Error triggering form submit:', e);
            }
          }
        }, 300);
        
      } catch (error) {
        this.debug('Error simulating download:', error);
        restoreOriginals();
        resolve(null);
      }
    });
  }

  private async interceptDownloadRequest(downloadButton: HTMLElement): Promise<string | null> {
    return new Promise((resolve) => {
      this.debug('Attempting to intercept download request');
      
      const originalFetch = window.fetch;
      const originalXHROpen = XMLHttpRequest.prototype.open;
      let capturedUrl: string | null = null;
      let timeoutId: number;
      
      // Override fetch
      window.fetch = function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === 'string' ? input : 
                    input instanceof URL ? input.toString() : 
                    (input as Request).url;
        
        if (url.includes('amazonaws.com') && (url.includes('X-Amz-') || url.includes('.json.gz'))) {
          capturedUrl = url;
          window.fetch = originalFetch;
          XMLHttpRequest.prototype.open = originalXHROpen;
          resolve(capturedUrl);
          return Promise.reject(new Error('Request intercepted for preview'));
        }
        
        return originalFetch.call(this, input, init);
      };
      
      // Override XMLHttpRequest
      XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null): void {
        const urlStr = url.toString();
        if (urlStr.includes('amazonaws.com') && (urlStr.includes('X-Amz-') || urlStr.includes('.json.gz'))) {
          capturedUrl = urlStr;
          window.fetch = originalFetch;
          XMLHttpRequest.prototype.open = originalXHROpen;
          resolve(capturedUrl);
          return;
        }
        
        return originalXHROpen.call(this, method, url, async, username, password);
      };
      
      // Set timeout to restore functions
      timeoutId = window.setTimeout(() => {
        window.fetch = originalFetch;
        XMLHttpRequest.prototype.open = originalXHROpen;
        resolve(capturedUrl);
      }, 3000);
      
      // Trigger the download
      try {
        // Try clicking the button with different event types
        const events = ['click', 'mousedown', 'mouseup'];
        for (const eventType of events) {
          const event = new MouseEvent(eventType, {
            bubbles: true,
            cancelable: true,
            view: window
          });
          downloadButton.dispatchEvent(event);
          
          // Small delay between events
          setTimeout(() => {}, 10);
        }
        
        // Also try direct click
        if (downloadButton.onclick) {
          downloadButton.onclick(new MouseEvent('click'));
        }
        
      } catch (error) {
        this.debug('Error triggering download:', error);
        window.clearTimeout(timeoutId);
        window.fetch = originalFetch;
        XMLHttpRequest.prototype.open = originalXHROpen;
        resolve(null);
      }
    });
  }

  private extractUrlFromPageContext(fileName: string): string | null {
    this.debug('Extracting URL from page context for:', fileName);
    
    // Look for pre-signed URLs in links
    const allLinks = Array.from(document.querySelectorAll('a[href*="amazonaws.com"]')) as HTMLAnchorElement[];
    for (const link of allLinks) {
      if ((link.href.includes(fileName) || link.href.includes('X-Amz-')) && link.href.includes('amazonaws.com')) {
        this.debug('Found potential pre-signed link:', link.href);
        return link.href;
      }
    }
    
    // Look in script tags
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const content = script.textContent || '';
      
      // Look for pre-signed URLs with authentication
      const preSignedMatches = content.match(/https:\/\/[^"'\s]+\.amazonaws\.com[^"'\s]*X-Amz-[^"'\s]*/g);
      if (preSignedMatches) {
        for (const url of preSignedMatches) {
          if (url.includes(fileName.replace(/\./g, '\\.'))) {
            this.debug('Found pre-signed URL in script:', url);
            return url;
          }
        }
        // If we found pre-signed URLs but none match the filename exactly, try the first one
        if (preSignedMatches.length > 0) {
          this.debug('Found generic pre-signed URL:', preSignedMatches[0]);
          return preSignedMatches[0];
        }
      }
    }
    
    // Look in the HTML for any AWS URLs
    const htmlContent = document.documentElement.innerHTML;
    const awsUrlMatches = htmlContent.match(/https:\/\/[^"'\s]+\.amazonaws\.com[^"'\s]*X-Amz-[^"'\s]*/g);
    if (awsUrlMatches) {
      for (const url of awsUrlMatches) {
        if (url.includes(fileName)) {
          this.debug('Found AWS URL in HTML:', url);
          return url;
        }
      }
    }
    
    return null;
  }

  private extractDownloadUrlFromDetailPage(downloadButton: HTMLElement): string | null {
    this.debug('Extracting download URL from button:', downloadButton);
    
    if (downloadButton.tagName === 'A') {
      const href = (downloadButton as HTMLAnchorElement).href;
      this.debug('Found href on anchor:', href);
      return href;
    }

    // Check for various URL attributes
    const urlAttributes = ['data-url', 'data-href', 'data-download-url', 'data-presigned-url'];
    for (const attr of urlAttributes) {
      const url = downloadButton.getAttribute(attr);
      if (url) {
        this.debug('Found URL in attribute', attr, url);
        return url;
      }
    }

    // Look for onclick handler
    const onclick = downloadButton.getAttribute('onclick');
    if (onclick) {
      const urlMatch = onclick.match(/https?:\/\/[^\s'",)]+/);
      if (urlMatch) {
        this.debug('Found URL in onclick:', urlMatch[0]);
        return urlMatch[0];
      }
    }

    // Check parent elements
    let parent = downloadButton.parentElement;
    while (parent && parent !== document.body) {
      if (parent.tagName === 'A') {
        const href = (parent as HTMLAnchorElement).href;
        if (href && href.includes('amazonaws.com')) {
          this.debug('Found parent link:', href);
          return href;
        }
      }
      parent = parent.parentElement;
    }

    return null;
  }

  private async fetchAndDisplayS3File(downloadUrl: string, fileName: string, anchorElement: HTMLElement): Promise<void> {
    this.debug('Fetching S3 file from URL:', downloadUrl);
    
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }

    const binaryData = new Uint8Array(await response.arrayBuffer());
    
    const decompressedData = this.decompressGzip(binaryData);
    const jsonString = new TextDecoder().decode(decompressedData);
    const parsedJson = JSON.parse(jsonString);
    const formattedJson = JSON.stringify(parsedJson, null, 2);

    this.showS3PreviewPanel(formattedJson, anchorElement, fileName);
  }

  private extractDownloadUrl(downloadButton: HTMLElement): string | null {
    if (downloadButton.tagName === 'A') {
      return (downloadButton as HTMLAnchorElement).href;
    }

    const parentLink = downloadButton.closest('a[href]') as HTMLAnchorElement;
    if (parentLink) {
      return parentLink.href;
    }

    const dataUrl = downloadButton.dataset.url || downloadButton.dataset.href;
    if (dataUrl) {
      return dataUrl;
    }

    return null;
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