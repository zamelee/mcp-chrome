/**
 * Token Value Display Helper (Phase 5.3)
 *
 * Wraps an existing InputContainer so that, when the underlying CSS value is a
 * `var(--token)` reference, the numeric/text input is hidden and a TokenPill
 * is shown in its place. Clicking the pill opens a TokenPicker for the given
 * token kind (length / number / all); clearing the pill detaches the token.
 *
 * The helper does NOT write to the DOM itself - it emits two callbacks
 * (`onTokenSelected`, `onTokenCleared`) so the calling control can decide how
 * to apply the new value through its own TransactionManager pipeline.
 *
 * Visual contract:
 * - When the wrapper is rendered in a `.we-field-row` it inherits the same
 *   `flex: 1 1 0; min-width: 0` sizing the original InputContainer had.
 * - The wrapper has `position: relative` so the picker dropdown positions
 *   relative to it (matches ColorField's pattern).
 */

import { Disposer } from '../../../utils/disposables';
import type { CssVarName, DesignTokensService } from '../../../core/design-tokens';
import { createTokenPill, type TokenPill } from '../components/token-pill';
import { createTokenPicker, type TokenPicker } from './token-picker';

// =============================================================================
// Types
// =============================================================================

export interface TokenValueDisplayOptions {
  /**
   * DOM elements that are visible in input mode and hidden in token mode.
   * Typically a single InputContainer root, or a SliderInput root for
   * composite fields like opacity.
   */
  valueHolders: HTMLElement[];
  /** Accessible label for the pill (e.g., "Width token"). */
  ariaLabel: string;
  /** Design tokens service used for parsing and the picker. */
  tokensService: DesignTokensService;
  /**
   * Token kind filter for the picker dropdown.
   *   - 'length' for size/spacing/position
   *   - 'all'    for any field that may bind tokens of mixed kinds
   *              (z-index/opacity/line-height pass through 'all' since the
   *               picker only filters by color/length/all)
   */
  tokenKind: 'length' | 'all';
  /** Called when user picks a token - caller applies `cssValue` (var(...)). */
  onTokenSelected: (tokenName: CssVarName, cssValue: string) => void;
  /** Called when user clears the pill - caller should detach var() and resolve. */
  onTokenCleared: () => void;
}

export interface TokenValueDisplay {
  /**
   * Wrapper element that owns the original InputContainer + the pill + the
   * picker dropdown. Mount this in place of `inputContainer.root`.
   */
  root: HTMLDivElement;
  /** Update which token is shown in the pill (e.g., after target changes). */
  setTokenName(name: CssVarName | null): void;
  /**
   * Toggle visibility between input and pill based on a raw CSS value.
   * If the value parses as `var(--name)` the pill is shown; otherwise the
   * input is shown.
   */
  syncValue(rawValue: string): void;
  /** Forward disabled state to the pill (input is managed by caller). */
  setDisabled(disabled: boolean): void;
  /** Cleanup pill, picker and event listeners. */
  dispose(): void;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a token-value display that wraps an existing InputContainer.
 */
export function createTokenValueDisplay(options: TokenValueDisplayOptions): TokenValueDisplay {
  const { valueHolders, ariaLabel, tokensService, tokenKind, onTokenSelected, onTokenCleared } =
    options;

  const disposer = new Disposer();

  // ---------------------------------------------------------------------------
  // DOM Wrapper
  // ---------------------------------------------------------------------------

  const root = document.createElement('div');
  root.className = 'we-token-value-display';
  // Mirror the sizing the InputContainer had when it lived directly in a row
  // (see `.we-field-row > .we-input-container` rule in shadow-host.ts).
  root.style.flex = '1 1 0';
  root.style.minWidth = '0';
  root.style.position = 'relative';
  root.style.display = 'flex';

  // Move the original input into the wrapper so we can toggle it cleanly.
  for (const holder of valueHolders) {
    root.appendChild(holder);
  }

  // ---------------------------------------------------------------------------
  // Pill
  // ---------------------------------------------------------------------------

  const pill = createTokenPill({
    container: root,
    ariaLabel: `${ariaLabel} token`,
    tokenName: '',
    disabled: false,
    onClick: () => {
      if (disposer.isDisposed) return;
      picker.toggle();
    },
    onClear: () => {
      if (disposer.isDisposed) return;
      picker.hide();
      onTokenCleared();
    },
  });
  pill.root.hidden = true;
  // Ensure the pill fills the wrapper like the input does.
  pill.root.style.flex = '1 1 0';
  pill.root.style.minWidth = '0';
  disposer.add(() => pill.dispose());

  // ---------------------------------------------------------------------------
  // Picker
  // ---------------------------------------------------------------------------

  const picker = createTokenPicker({
    container: root,
    tokensService,
    tokenKind,
    onSelect: (tokenName, cssValue) => {
      if (disposer.isDisposed) return;
      onTokenSelected(tokenName, cssValue);
    },
  });
  disposer.add(() => picker.dispose());

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let isTokenMode = false;
  let isDisabled = false;
  let currentTokenName: CssVarName | null = null;

  function showInput(): void {
    if (disposer.isDisposed) return;
    if (!isTokenMode) return;
    isTokenMode = false;
    currentTokenName = null;
    pill.root.hidden = true;
    for (const holder of valueHolders) holder.hidden = false;
  }

  function showPill(name: CssVarName): void {
    if (disposer.isDisposed) return;
    if (isTokenMode && currentTokenName === name) return;
    isTokenMode = true;
    currentTokenName = name;
    pill.setTokenName(name);
    pill.root.hidden = false;
    for (const holder of valueHolders) holder.hidden = true;
    // Drop any active picker state to avoid stale dropdowns.
    picker.hide();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function syncValue(rawValue: string): void {
    if (disposer.isDisposed) return;
    const trimmed = (rawValue ?? '').trim();
    const ref = trimmed ? tokensService.parseCssVar(trimmed) : null;
    if (ref && ref.name) {
      showPill(ref.name);
    } else {
      showInput();
    }
  }

  function setTokenName(name: CssVarName | null): void {
    if (name) showPill(name);
    else showInput();
  }

  function setDisabled(disabled: boolean): void {
    isDisabled = disabled;
    pill.setDisabled(disabled);
  }

  function dispose(): void {
    disposer.dispose();
  }

  return {
    root,
    setTokenName,
    syncValue,
    setDisabled,
    dispose,
  };
}
