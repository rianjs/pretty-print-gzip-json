import * as pako from 'pako';

interface FormatResult {
  success: boolean;
  data?: string;
  error?: string;
}

class PayloadFormatter {
  private _lastRightClickedElement: HTMLElement | null = null;

  constructor() {
    this.attachEventListeners();
    this.registerMessageHandler();
  }

  private attachEventListeners(): void {
    document.addEventListener('contextmenu', (event) => {
      this._lastRightClickedElement = event.target as HTMLElement;
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

    return this.processPayload(content);
  }

  private processPayload(base64Content: string): FormatResult {
    try {
      const binaryData = this.decodeBase64(base64Content);
      const decompressedData = this.decompressGzip(binaryData);
      const jsonString = new TextDecoder().decode(decompressedData);
      const parsedJson = JSON.parse(jsonString);
      const formattedJson = JSON.stringify(parsedJson, null, 2);
      
      this.copyToClipboard(formattedJson);
      
      return { success: true, data: formattedJson };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to process payload: ${errorMessage}` };
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