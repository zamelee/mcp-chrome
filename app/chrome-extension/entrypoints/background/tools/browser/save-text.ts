import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from '@ethanwilkins/chrome-mcp-shared-2026';
import { forwardFileOperationToNative } from '../../native-host';

interface SaveTextToolParams {
  /** Plain text content to write to disk (will be UTF-8 encoded). */
  text: string;
  /** Absolute filesystem path. Forward-slash on Windows per §11. */
  filePath: string;
  /** Optional MIME type hint (e.g. 'text/markdown', 'application/json'). Defaults to text/plain. */
  mimeType?: string;
  tabId?: number;
  windowId?: number;
}

/**
 * v1.9.5: Tool for saving text content to disk via the native host.
 *
 * Replaces the broken Blob+anchor.click() pattern that triggered Chrome's
 * native download UI ("Save As" dialog). Per AGENTS.md §0b.7.7, all disk
 * writes go through native-host fs.writeFileSync with atomic write-rename,
 * which bypasses chrome.downloads entirely.
 *
 * Use case: agent has collected data from the page (assistant response,
 * extracted DOM, etc.) and needs to persist it without the user seeing
 * a Save As dialog.
 *
 * For images, use chrome_screenshot with savePath instead.
 */
class SaveTextTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SAVE_TEXT as any;

  async execute(args: SaveTextToolParams): Promise<ToolResult> {
    const { text, filePath, mimeType = 'text/plain' } = args || ({} as SaveTextToolParams);

    if (typeof text !== 'string' || text.length === 0) {
      return createErrorResponse('text is required and must be a non-empty string');
    }
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return createErrorResponse('filePath is required (absolute path, forward-slash on Windows)');
    }

    // Normalize backslashes to forward-slash per §11 (Markdown / Codex Desktop contract).
    // The native-host file-handler accepts both, but forward-slash avoids shell escape issues.
    const normalizedPath = filePath.replace(/\\/g, '/');

    try {
      // Encode text as base64 (UTF-8). file-handler's prepareFile action
      // accepts base64Data + filePath and writes via atomic write-rename.
      // Same protocol as chrome_screenshot savePath (AGENTS.md §0b.7.7).
      const utf8Bytes = new TextEncoder().encode(text);
      let bin = '';
      for (const b of utf8Bytes) bin += String.fromCharCode(b);
      const base64Data = btoa(bin);

      const result = await forwardFileOperationToNative(
        {
          action: 'prepareFile',
          base64Data,
          filePath: normalizedPath,
          mimeType,
        },
        { timeoutMs: 30_000 },
      );

      if (!result.success || !result.filePath) {
        return createErrorResponse(
          `save_text: native host failed: ${result.error ?? 'unknown error'}`,
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              filePath: result.filePath,
              size: result.size,
              mimeType,
              viaAtomicWrite: true,
            }),
          },
        ],
        isError: false,
      };
    } catch (e) {
      return createErrorResponse(`save_text: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const saveTextTool = new SaveTextTool();
