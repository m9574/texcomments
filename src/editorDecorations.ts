import * as vscode from "vscode";
import { DecoratedLatexSnippet, LatexRenderResult } from "./types";

export interface LatexDecorationTypes {
  hiddenInline: vscode.TextEditorDecorationType;
  renderedInline: vscode.TextEditorDecorationType;
  activeInline: vscode.TextEditorDecorationType;
  invalid: vscode.TextEditorDecorationType;
}

/* Creates editor decoration types that use theme colors so rendered snippets remain readable across light, dark, and custom themes consistently. */
export function createLatexDecorationTypes(): LatexDecorationTypes {
  const hiddenInlineDecoration = vscode.window.createTextEditorDecorationType({
    color: "rgba(0, 0, 0, 0)",
    textDecoration: "none; font-size: 0;"
  });

  const renderedInlineDecoration = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor("charts.green"),
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  const activeInlineDecoration = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor("charts.green"),
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  const invalidDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("inputValidation.errorBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("inputValidation.errorBorder"),
    borderRadius: "3px",
    overviewRulerColor: new vscode.ThemeColor("inputValidation.errorBorder"),
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  return {
    hiddenInline: hiddenInlineDecoration,
    renderedInline: renderedInlineDecoration,
    activeInline: activeInlineDecoration,
    invalid: invalidDecoration
  };
}

/* Applies rendered and invalid snippet decorations separately so pending valid snippets stay visually quiet while async rendering completes inside editors. */
export function applyLatexDecorations(
  editor: vscode.TextEditor,
  decorationTypes: LatexDecorationTypes,
  decoratedSnippets: DecoratedLatexSnippet[]
): void {
  const hiddenInlineOptions: vscode.DecorationOptions[] = [];
  const renderedInlineOptions: vscode.DecorationOptions[] = [];
  const activeInlineOptions: vscode.DecorationOptions[] = [];
  const invalidOptions: vscode.DecorationOptions[] = [];

  for (const decoratedSnippet of decoratedSnippets) {
    if (isRenderedActiveInlineSnippet(decoratedSnippet)) {
      activeInlineOptions.push(createSourceDecorationOption(decoratedSnippet));
    } else if (shouldSkipActiveInlineSnippet(decoratedSnippet)) {
      continue;
    } else if (isDecoratedSnippetRendered(decoratedSnippet)) {
      hiddenInlineOptions.push(createHiddenSourceDecorationOption(decoratedSnippet));
      renderedInlineOptions.push(createRenderedImageDecorationOption(decoratedSnippet));
    } else if (!decoratedSnippet.snippet.validation.isValid) {
      invalidOptions.push(createRangeDecorationOption(decoratedSnippet));
    }
  }

  editor.setDecorations(decorationTypes.hiddenInline, hiddenInlineOptions);
  editor.setDecorations(decorationTypes.renderedInline, renderedInlineOptions);
  editor.setDecorations(decorationTypes.activeInline, activeInlineOptions);
  editor.setDecorations(decorationTypes.invalid, invalidOptions);
}

/* Clears every Texcomment decoration type from an editor, which supports toggling the extension off cleanly without stale previews remaining visible. */
export function clearLatexDecorations(editor: vscode.TextEditor, decorationTypes: LatexDecorationTypes): void {
  editor.setDecorations(decorationTypes.hiddenInline, []);
  editor.setDecorations(decorationTypes.renderedInline, []);
  editor.setDecorations(decorationTypes.activeInline, []);
  editor.setDecorations(decorationTypes.invalid, []);
}

/* Creates a plain range decoration option for invalid snippets so validation styling stays separate from rendered SVG hover behavior in editors. */
function createRangeDecorationOption(decoratedSnippet: DecoratedLatexSnippet): vscode.DecorationOptions {
  return {
    range: decoratedSnippet.snippet.range
  };
}

/* Creates a source-hiding decoration option without hover details so original LaTeX text never becomes the larger preview hitbox area inside editors. */
function createHiddenSourceDecorationOption(decoratedSnippet: DecoratedLatexSnippet): vscode.DecorationOptions {
  return {
    range: decoratedSnippet.snippet.range
  };
}

/* Creates a rendered image decoration across the full snippet range while leaving hover ownership to the inlay hint preview marker. */
function createRenderedImageDecorationOption(decoratedSnippet: DecoratedLatexSnippet): vscode.DecorationOptions {
  const snippet = decoratedSnippet.snippet;
  const renderResult = decoratedSnippet.renderResult;

  if (isRenderedSnippetResult(renderResult)) {
    return {
      range: snippet.range,
      renderOptions: createRenderedImageOptions(renderResult)
    };
  }

  return {
    range: snippet.range
  };
}

/* Creates a source-visible decoration option for active inline snippets, preserving editability without showing rendered hover previews directly over source text. */
function createSourceDecorationOption(decoratedSnippet: DecoratedLatexSnippet): vscode.DecorationOptions {
  return {
    range: decoratedSnippet.snippet.range
  };
}

/* Checks whether selected inline math should show raw source only, keeping editing free from rendered preview attachments in source editors. */
function shouldSkipActiveInlineSnippet(decoratedSnippet: DecoratedLatexSnippet): boolean {
  if (!decoratedSnippet.isSourceLineSelected) {
    return false;
  }

  return true;
}

/* Checks whether selected inline math already has a rendered result and should receive source-visible decoration while active in editing sessions. */
function isRenderedActiveInlineSnippet(decoratedSnippet: DecoratedLatexSnippet): boolean {
  if (!decoratedSnippet.isSourceLineSelected) {
    return false;
  }

  if (isDecoratedSnippetRendered(decoratedSnippet)) {
    return true;
  }

  return false;
}

/* Checks whether one decorated snippet has a completed render result and should visually replace source text when inactive in editors. */
function isDecoratedSnippetRendered(decoratedSnippet: DecoratedLatexSnippet): boolean {
  if (decoratedSnippet.snippet.validation.isValid) {
    return isRenderedSnippetResult(decoratedSnippet.renderResult);
  }

  return false;
}

/* Checks whether a render result includes both theme SVG files needed for image attachments in the editor decoration layer safely. */
function isRenderedSnippetResult(renderResult: LatexRenderResult | undefined): renderResult is LatexRenderResult {
  if (renderResult === undefined) {
    return false;
  }

  if (!renderResult.isRendered) {
    return false;
  }

  if (renderResult.lightSvgUri === undefined) {
    return false;
  }

  if (renderResult.darkSvgUri === undefined) {
    return false;
  }

  return true;
}

/* Creates per-theme image decoration options so rendered inline equations replace source text after asynchronous rendering completes inside source editors safely. */
function createRenderedImageOptions(renderResult: LatexRenderResult): vscode.DecorationInstanceRenderOptions {
  const lightAttachment = createRenderedImageAttachment(renderResult.lightSvgUri);
  const darkAttachment = createRenderedImageAttachment(renderResult.darkSvgUri);
  return {
    before: lightAttachment,
    light: {
      before: lightAttachment
    },
    dark: {
      before: darkAttachment
    }
  };
}

/* Creates a rendered equation attachment whose SVG file has already been physically sized before VS Code receives the decoration image. */
function createRenderedImageAttachment(svgUri: vscode.Uri | undefined): vscode.ThemableDecorationAttachmentRenderOptions {
  return {
    contentIconPath: svgUri,
    margin: "0 0.25rem 0 0",
    width: "auto",
    textDecoration: "none; vertical-align: text-bottom;"
  };
}
