/**
 * Unit tests for Token Value Display helper (Phase 5.3).
 *
 * Focuses on:
 * - syncValue() toggles input vs pill based on var() detection
 * - onTokenSelected / onTokenCleared callbacks are forwarded to the caller
 * - dispose() tears down pill + picker
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTokenValueDisplay } from '@/entrypoints/web-editor-v2/ui/property-panel/controls/token-value-helper';
import { createInputContainer } from '@/entrypoints/web-editor-v2/ui/property-panel/components/input-container';
import { createDesignTokensService } from '@/entrypoints/web-editor-v2/core/design-tokens';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('token-value-helper', () => {
  it('shows input by default and hides the pill', () => {
    const tokensService = createDesignTokensService();
    const inputContainer = createInputContainer({ ariaLabel: 'Width' });
    const onSelected = vi.fn();
    const onCleared = vi.fn();

    const display = createTokenValueDisplay({
      valueHolders: [inputContainer.root],
      ariaLabel: 'Width',
      tokensService,
      tokenKind: 'length',
      onTokenSelected: onSelected,
      onTokenCleared: onCleared,
    });

    expect(inputContainer.root.hidden).toBe(false);
    expect(
      (display.root.querySelector('.we-token-pill') as HTMLElement | null)?.hidden ?? true,
    ).toBe(true);

    display.dispose();
  });

  it('swaps to pill when value parses as var()', () => {
    const tokensService = createDesignTokensService();
    const inputContainer = createInputContainer({ ariaLabel: 'Width' });
    const display = createTokenValueDisplay({
      valueHolders: [inputContainer.root],
      ariaLabel: 'Width',
      tokensService,
      tokenKind: 'length',
      onTokenSelected: vi.fn(),
      onTokenCleared: vi.fn(),
    });

    display.syncValue('var(--spacing-md)');

    expect(inputContainer.root.hidden).toBe(true);
    const pill = display.root.querySelector('.we-token-pill') as HTMLElement;
    expect(pill).toBeTruthy();
    expect(pill.hidden).toBe(false);
    expect(pill.querySelector('.we-token-pill__name')?.textContent).toBe('--spacing-md');

    display.dispose();
  });

  it('swaps back to input when value becomes a literal', () => {
    const tokensService = createDesignTokensService();
    const inputContainer = createInputContainer({ ariaLabel: 'Width' });
    const display = createTokenValueDisplay({
      valueHolders: [inputContainer.root],
      ariaLabel: 'Width',
      tokensService,
      tokenKind: 'length',
      onTokenSelected: vi.fn(),
      onTokenCleared: vi.fn(),
    });

    display.syncValue('var(--spacing-md)');
    expect(inputContainer.root.hidden).toBe(true);

    display.syncValue('12px');
    expect(inputContainer.root.hidden).toBe(false);
    const pill = display.root.querySelector('.we-token-pill') as HTMLElement;
    expect(pill.hidden).toBe(true);

    display.dispose();
  });

  it('forwards onTokenCleared when pill clear button is clicked', () => {
    const tokensService = createDesignTokensService();
    const inputContainer = createInputContainer({ ariaLabel: 'Width' });
    const onCleared = vi.fn();
    const display = createTokenValueDisplay({
      valueHolders: [inputContainer.root],
      ariaLabel: 'Width',
      tokensService,
      tokenKind: 'length',
      onTokenSelected: vi.fn(),
      onTokenCleared: onCleared,
    });

    display.syncValue('var(--spacing-md)');

    const clearBtn = display.root.querySelector('.we-token-pill__clear') as HTMLButtonElement;
    expect(clearBtn).toBeTruthy();
    clearBtn.click();

    expect(onCleared).toHaveBeenCalledTimes(1);

    display.dispose();
  });

  it('setDisabled forwards state to pill', () => {
    const tokensService = createDesignTokensService();
    const inputContainer = createInputContainer({ ariaLabel: 'Width' });
    const display = createTokenValueDisplay({
      valueHolders: [inputContainer.root],
      ariaLabel: 'Width',
      tokensService,
      tokenKind: 'length',
      onTokenSelected: vi.fn(),
      onTokenCleared: vi.fn(),
    });

    display.syncValue('var(--spacing-md)');
    const pill = display.root.querySelector('.we-token-pill') as HTMLElement;
    expect(pill.dataset.disabled).toBe('false');

    display.setDisabled(true);
    expect(pill.dataset.disabled).toBe('true');

    display.dispose();
  });
});
