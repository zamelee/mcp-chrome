import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from '@ethanwilkins/chrome-mcp-shared-2026';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { forwardFileOperationToNative } from '../../native-host';

interface FileUploadToolParams {
  selector: string; // CSS selector for the file input element
  filePath?: string; // Local file path
  fileUrl?: string; // URL to download file from
  base64Data?: string; // Base64 encoded file data
  fileName?: string; // Optional filename when using base64 or URL
  multiple?: boolean; // Whether to allow multiple files
  tabId?: number; // Target existing tab id
  windowId?: number; // When no tabId, pick active tab from this window
  /** v1.9.5: postcondition probe to distinguish 'uploaded-but-rejected' from 'uploaded-with-stale-toast'. */
  verifyPostcondition?: boolean;
}

/**
 * Tool for uploading files to web forms using Chrome DevTools Protocol
 * Similar to Playwright's setInputFiles implementation
 */
class FileUploadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILE_UPLOAD;
  constructor() {
    super();
  }

  /**
   * Execute file upload operation using Chrome DevTools Protocol
   */
  async execute(args: FileUploadToolParams): Promise<ToolResult> {
    const {
      selector,
      filePath,
      fileUrl,
      base64Data,
      fileName,
      multiple = false,
      verifyPostcondition = true,
    } = args;

    console.log(`Starting file upload operation with options:`, args);

    // Validate input
    if (!selector) {
      return createErrorResponse('Selector is required for file upload');
    }

    if (!filePath && !fileUrl && !base64Data) {
      return createErrorResponse('One of filePath, fileUrl, or base64Data must be provided');
    }

    try {
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) return createErrorResponse('No active tab found');
      const tabId = tab.id;

      // Prepare file paths
      let files: string[] = [];

      if (filePath) {
        // Direct file path provided
        files = [filePath];
      } else if (fileUrl || base64Data) {
        // For URL or base64, we need to use the native messaging host
        // to download or save the file temporarily
        const tempFilePath = await this.prepareFileFromRemote({
          fileUrl,
          base64Data,
          fileName: fileName || 'uploaded-file',
        });
        if (!tempFilePath) {
          return createErrorResponse('Failed to prepare file for upload');
        }
        files = [tempFilePath];
      }

      // Use shared CDP session manager to attach/do work/detach safely
      await cdpSessionManager.withSession(tabId, 'file-upload', async () => {
        // Enable necessary CDP domains
        await cdpSessionManager.sendCommand(tabId, 'DOM.enable', {});
        await cdpSessionManager.sendCommand(tabId, 'Runtime.enable', {});

        // Get the document
        const { root } = (await cdpSessionManager.sendCommand(tabId, 'DOM.getDocument', {
          depth: -1,
          pierce: true,
        })) as { root: { nodeId: number } };

        // Find the file input element using the selector
        const { nodeId } = (await cdpSessionManager.sendCommand(tabId, 'DOM.querySelector', {
          nodeId: root.nodeId,
          selector: selector,
        })) as { nodeId: number };

        if (!nodeId || nodeId === 0) {
          throw new Error(`Element with selector "${selector}" not found`);
        }

        // Verify it's actually a file input
        const { node } = (await cdpSessionManager.sendCommand(tabId, 'DOM.describeNode', {
          nodeId,
        })) as { node: { nodeName: string; attributes?: string[] } };

        if (node.nodeName !== 'INPUT') {
          throw new Error(`Element with selector "${selector}" is not an input element`);
        }

        // Check if it's a file input by looking for type="file" in attributes
        const attributes = node.attributes || [];
        let isFileInput = false;
        for (let i = 0; i < attributes.length; i += 2) {
          if (attributes[i] === 'type' && attributes[i + 1] === 'file') {
            isFileInput = true;
            break;
          }
        }

        if (!isFileInput) {
          throw new Error(`Element with selector "${selector}" is not a file input (type="file")`);
        }

        // Set the files on the input element
        await cdpSessionManager.sendCommand(tabId, 'DOM.setFileInputFiles', {
          nodeId,
          files,
        });

        // Trigger change event to ensure the page reacts to the file upload
        await cdpSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
          expression: `
            (function() {
              const element = document.querySelector('${selector.replace(/'/g, "\\'")}');
              if (element) {
                const event = new Event('change', { bubbles: true });
                element.dispatchEvent(event);
                return true;
              }
              return false;
            })()
          `,
        });
      });

      // Postcondition verification (v1.9.5): probe DOM after upload to distinguish
      // 'uploaded-but-rejected' from 'uploaded-with-stale-toast'. Best-effort:
      // probe failure does not fail the upload call itself.
      const postcondition = verifyPostcondition
        ? await this._verifyUploadPostcondition(tabId, selector, files, cdpSessionManager)
        : { status: 'skipped' };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'File(s) uploaded successfully',
              files: files,
              selector: selector,
              fileCount: files.length,
              postcondition,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in file upload operation:', error);

      // Session manager handles detach; nothing extra needed here

      return createErrorResponse(
        `Error uploading file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // All debugger attach/detach is centrally managed by cdpSessionManager

  /**
   * Postcondition verification after chrome_upload_file (v1.9.5).
   *
   * Distinguishes three states so agents do not confuse prior uploads'
   * stale error toast with the new upload's actual rejection (bug
   * observed on chatgpt.com silent dedup and github.com/copilot
   * CJK+markdown rejection).
   */
  private async _verifyUploadPostcondition(
    tabId: number,
    selector: string,
    expectedFiles: string[],
    cdp: typeof cdpSessionManager,
  ): Promise<{
    status: 'succeeded' | 'rejected' | 'dialog_blocked' | 'uncertain' | 'probe_failed';
    fileInputFiles?: string[];
    chipTexts?: string[];
    newErrors?: string[];
    dialogText?: string;
    dedupKeyword?: string;
    reason?: string;
  }> {
    const expected = expectedFiles.map((f) => {
      const parts = String(f).split(/[/\\\\]/);
      return parts[parts.length - 1] || String(f);
    });
    const selectorSafe = String(selector).replace(/'/g, "\\\\'");
    const probeExpression = `
      (function() {
        const el = document.querySelector('${selectorSafe}');
        const files = el && el.files ? Array.from(el.files).map(f => f.name) : [];
        const chipSelectors = ['[class*="attachment"]','[class*="Chip"]','[class*="chip"]','[data-testid*="attachment"]','[role="listitem"]','li'];
        const chips = new Set();
        for (const sel of chipSelectors) {
          document.querySelectorAll(sel).forEach(n => {
            if (n.offsetParent === null) return;
            const t = (n.textContent || '').trim();
            if (t.length > 0 && t.length < 300) chips.add(t);
          });
        }
        const errSelectors = ['[role="alert"]','[class*="error"]','[class*="Error"]','[class*="toast"]','[class*="Toast"]','[class*="banner"]'];
        const errs = new Set();
        for (const sel of errSelectors) {
          document.querySelectorAll(sel).forEach(n => {
            if (n.offsetParent === null) return;
            const t = (n.textContent || '').trim();
            if (t.length > 5 && t.length < 500) errs.add(t);
          });
        }
        // v1.10.0: also collect visible [role="dialog"] text. Some vendors
        // (chatgpt) surface dedup as a dialog rather than a banner.
        const dialogs = new Set();
        document.querySelectorAll('[role="dialog"]').forEach(n => {
          if (n.offsetParent === null) return;
          const t = (n.textContent || '').trim();
          if (t.length > 5 && t.length < 500) dialogs.add(t);
        });
        return JSON.stringify({ fileInputFiles: files, chips: Array.from(chips), errors: Array.from(errs), dialogs: Array.from(dialogs) });
      })()
    `;
    try {
      const evalResult = (await cdp.sendCommand(tabId, 'Runtime.evaluate', {
        expression: probeExpression,
        returnByValue: true,
      })) as { result?: { value?: string } };
      const value = evalResult?.result?.value;
      if (typeof value !== 'string') {
        return { status: 'probe_failed', reason: 'probe returned non-string' };
      }
      let parsed: {
        fileInputFiles: string[];
        chips: string[];
        errors: string[];
        dialogs: string[];
      };
      try {
        parsed = JSON.parse(value);
      } catch {
        return { status: 'probe_failed', reason: 'JSON parse failed' };
      }
      const fileInputFiles = Array.isArray(parsed.fileInputFiles) ? parsed.fileInputFiles : [];
      const chipTexts = Array.isArray(parsed.chips) ? parsed.chips : [];
      const newErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
      const newDialogs = Array.isArray(parsed.dialogs) ? parsed.dialogs : [];
      const allMatched = expected.length > 0 && expected.every((n) => fileInputFiles.includes(n));
      const chipMatched =
        expected.length === 0 || expected.some((n) => chipTexts.some((c) => c.includes(n)));

      // v1.10.0 Bug 2: filter instrumentation noise before keyword match.
      const errorsReal = newErrors.filter(isRealError);
      const errorsMentionFile = errorsReal.filter((e) => expected.some((n) => e.includes(n)));
      const errorsGeneric = errorsReal;

      // v1.10.0 Bug 3: scan dialogs for dedup signal.
      interface DedupMatch {
        text: string;
        keyword: string;
      }
      const dedupDialog = newDialogs
        .map((t): DedupMatch | null => {
          const keyword = extractDedupKeyword(t);
          return keyword === null ? null : { text: t, keyword };
        })
        .find((d): d is DedupMatch => d !== null);

      // v1.10.0 Bug 1: errors-first verdict order.
      if (errorsMentionFile.length > 0) {
        return {
          status: 'rejected',
          fileInputFiles,
          chipTexts: chipTexts.slice(0, 5),
          newErrors: errorsMentionFile.slice(0, 5),
          reason: 'page error references uploaded filename',
        };
      }
      if (dedupDialog) {
        return {
          status: 'dialog_blocked',
          fileInputFiles,
          chipTexts: chipTexts.slice(0, 5),
          newErrors: newErrors.slice(0, 5),
          dialogText: dedupDialog.text,
          dedupKeyword: dedupDialog.keyword,
          reason: 'visible dialog contains dedup keyword',
        };
      }
      if (!allMatched) {
        return {
          status: 'rejected',
          fileInputFiles,
          chipTexts: chipTexts.slice(0, 5),
          newErrors: newErrors.slice(0, 5),
          reason: 'file input did not reflect expected files (backend likely rejected)',
        };
      }
      if (chipMatched && errorsGeneric.length === 0) {
        return {
          status: 'succeeded',
          fileInputFiles,
          chipTexts: chipTexts.slice(0, 5),
          newErrors: [],
        };
      }
      return {
        status: 'uncertain',
        fileInputFiles,
        chipTexts: chipTexts.slice(0, 5),
        newErrors: newErrors.slice(0, 5),
        reason: chipMatched
          ? 'chip visible but generic errors also visible (may be stale)'
          : 'no chip detected (upload may be in-flight or backend rejected silently)',
      };
    } catch (e) {
      return { status: 'probe_failed', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Prepare file from URL or base64 data using native messaging host
   */
  private async prepareFileFromRemote(options: {
    fileUrl?: string;
    base64Data?: string;
    fileName: string;
  }): Promise<string | null> {
    const { fileUrl, base64Data, fileName } = options;

    // Direct nativePort.onMessage correlation via forwardFileOperationToNative.
    // Avoids MV3 SW message-queue race that previously caused 20s+ timeouts.
    return forwardFileOperationToNative(
      {
        action: 'prepareFile',
        fileUrl,
        base64Data,
        fileName,
      },
      { timeoutMs: 30_000 },
    )
      .then((result) => {
        if (result.success && result.filePath) {
          return result.filePath;
        }
        console.error('Native host failed to prepare file:', result.error ?? 'unknown error');
        return null;
      })
      .catch((err) => {
        console.error(
          `File preparation request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
  }
}

export const fileUploadTool = new FileUploadTool();
/**
 * v1.10.0: Multi-vendor upload-dedup signal detection.
 *
 * chatgpt.com fires a dialog with text like "You've already uploaded this
 * file. Try uploading something new." (per-account cache, surfaced as a
 * `role="dialog"` element). github.com/copilot rejects silently and surfaces
 * "unsupported file type" in a banner. gemini.google.com hash-dedups the
 * filename and either accepts the original content from conversation history
 * or silently rejects the re-upload.
 *
 * We catch all three via dialog text matching; downstream `status` is the
 * agent-facing signal.
 */
const DEDUP_KEYWORDS: RegExp[] = [
  /already uploaded/i,
  /file already exists/i,
  /duplicate (?:file|upload)/i,
  /\u5df2\u4e0a\u4f20/,
  /\u91cd\u590d\u4e0a\u4f20/,
  /\u6587\u4ef6\u5df2\u5b58\u5728/,
  /already attached/i,
  /already (?:been )?uploaded/i,
  /same file/i,
];

/**
 * v1.10.0: Filter out page instrumentation noise from collected `errors`.
 *
 * chatgpt.com embeds performance-marker scripts (`__oai_logHTML`, `__oai_SSR_*`,
 * `requestAnimationFrame`, inline `addEventListener` lambdas) inside
 * `role="alert"` nodes. The full textContent of those nodes is collected
 * by the previous probe, and matches against the uploaded filename when
 * `errorsMentionFile` runs. We strip these patterns before keyword-matching
 * so we only count real backend rejections.
 */
const INSTRUMENTATION_NOISE: RegExp[] = [
  /__oai_(?:logHTML|logTTI|SSR_HTML|SSR_TTI)/,
  /addEventListener\(`input`/,
  /requestAnimationFrame\(/,
  /window\.__oai_/,
  /performance\.mark/,
];

/** v1.10.0: True iff `text` looks like a real backend rejection (not instrumentation). */
function isRealError(text: string): boolean {
  if (INSTRUMENTATION_NOISE.some((p) => p.test(text))) return false;
  return /\b(?:error|fail|rejected|invalid|unsupported|denied|forbidden)\b/i.test(text);
}

/** v1.10.0: Return the first dedup keyword that matches `text`, or null. */
function extractDedupKeyword(text: string): string | null {
  for (const re of DEDUP_KEYWORDS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}
