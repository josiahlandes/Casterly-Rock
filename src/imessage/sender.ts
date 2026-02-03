import { execSync } from 'node:child_process';

export interface SendResult {
  success: boolean;
  error?: string;
}

/**
 * Escape a string for use in AppleScript
 */
function escapeForAppleScript(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Send an iMessage to a phone number or email
 */
export function sendMessage(recipient: string, text: string): SendResult {
  const escapedText = escapeForAppleScript(text);
  const escapedRecipient = escapeForAppleScript(recipient);

  // AppleScript to send a message
  const script = `
tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "${escapedRecipient}" of targetService
  send "${escapedText}" to targetBuddy
end tell
`;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    return { success: true };
  } catch (error) {
    // Try alternate approach using participant
    return sendMessageAlt(recipient, text);
  }
}

/**
 * Alternate send method using participant (works for new conversations)
 */
function sendMessageAlt(recipient: string, text: string): SendResult {
  const escapedText = escapeForAppleScript(text);
  const escapedRecipient = escapeForAppleScript(recipient);

  const script = `
tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set theBuddy to participant "${escapedRecipient}" of targetService
  send "${escapedText}" to theBuddy
end tell
`;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a message to an existing chat by chat identifier
 */
export function sendToChat(chatIdentifier: string, text: string): SendResult {
  const escapedText = escapeForAppleScript(text);
  const escapedChat = escapeForAppleScript(chatIdentifier);

  const script = `
tell application "Messages"
  set targetChat to chat "${escapedChat}"
  send "${escapedText}" to targetChat
end tell
`;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if Messages app is running and iMessage is available
 */
export function checkMessagesAvailable(): { available: boolean; error?: string } {
  const script = `
tell application "Messages"
  try
    set serviceCount to count of (services whose service type = iMessage)
    if serviceCount > 0 then
      return "ok"
    else
      return "no-imessage"
    end if
  on error errMsg
    return "error:" & errMsg
  end try
end tell
`;

  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    if (result === 'ok') {
      return { available: true };
    } else if (result === 'no-imessage') {
      return { available: false, error: 'iMessage service not found' };
    } else {
      return { available: false, error: result };
    }
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
