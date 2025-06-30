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
  private _debugMode = false; // Set to true to enable console logging

  constructor() {
    this.attachEventListeners();
    this.registerMessageHandler();
    this.createPreviewPanel();
    
    // Enable debug mode by setting window.dynamoDBFormatterDebug = true in console
    if ((window as any).dynamoDBFormatterDebug) {
      this._debugMode = true;
    }
  }

  private debug(message: string, ...args: any[]): void {
    if (this._debugMode) {
      console.debug('DynamoDB Formatter:', message, ...args);
    }
  }

  private attachEventListeners(): void {
    document.addEventListener('contextmenu', (event) => {
      this._lastRightClickedElement = event.target as HTMLElement;
    });

    // Only mousemove handles hover detection
    document.addEventListener('mousemove', this.handleMouseMove.bind(this), true);
  
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

    copyButton.addEventListener('mouseenter', () => {
      copyButton.style.background = styles.buttonHover;
    });

    copyButton.addEventListener('mouseleave', () => {
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

  private getThemeStyles(theme: 'light' | 'dark') {
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
      // Moved off a textarea to something else
      if (this._currentHoveredTextarea !== null) {
        this._currentHoveredTextarea = null;
        this.clearHoverTimer();
        this.hidePreviewPanel();
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
    return window.location.hostname.includes('console.aws.amazon.com');
  }

  private showPreviewForTextarea(textarea: HTMLTextAreaElement): void {
    if (!this._previewPanel || !textarea.value.trim()) {
      return;
    }
  
    const result = this.processPayload(textarea.value.trim());
  
    if (result.success && result.data) {
      this.showPreviewPanel(result.data, textarea);
  
      this._previewPanel.copyButton.onclick = () => {
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
    } catch (error) {
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
    } catch (error) {
      throw new Error('Invalid base64 encoding');
    }
  }

  private decompressGzip(compressedData: Uint8Array): Uint8Array {
    try {
      return pako.inflate(compressedData);
    } catch (error) {
      throw new Error('Failed to decompress gzip data');
    }
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
  }
}

new PayloadFormatter();