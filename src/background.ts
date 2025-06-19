chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'formatDynamoDBPayload',
    title: 'Copy as formatted JSON',
    contexts: ['editable'],
    documentUrlPatterns: ['https://*.console.aws.amazon.com/*']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'formatDynamoDBPayload' && tab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'formatPayload' });
      
      if (response.success) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon-48.png',
          title: 'DynamoDB Payload Formatter',
          message: 'Formatted JSON copied to clipboard!'
        });
      } else {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon-48.png',
          title: 'DynamoDB Payload Formatter',
          message: `Error: ${response.error}`
        });
      }
    } catch (error) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'DynamoDB Payload Formatter',
        message: 'Failed to format payload. Make sure you\'re right-clicking on a textarea.'
      });
    }
  }
});