import * as vscode from "vscode";
import { DecoratedLatexSnippet, LatexRenderResult } from "./types";

export const latexPreviewMarkerCommand = "texcomment.previewMarker";

export interface LatexInlayHintController extends vscode.Disposable {
  provider: vscode.InlayHintsProvider;
  didChangeInlayHintsEmitter: vscode.EventEmitter<void>;
  decoratedSnippetsByDocumentUri: Map<string, DecoratedLatexSnippet[]>;
}

/* Creates an inlay hint controller that stores rendered snippets and exposes a provider for explicit preview markers inside editors. */
export function createLatexInlayHintController(): LatexInlayHintController {
  const didChangeInlayHintsEmitter = new vscode.EventEmitter<void>();
  const decoratedSnippetsByDocumentUri = new Map<string, DecoratedLatexSnippet[]>();
  const provider = createLatexInlayHintsProvider(decoratedSnippetsByDocumentUri, didChangeInlayHintsEmitter);

  return {
    provider,
    didChangeInlayHintsEmitter,
    decoratedSnippetsByDocumentUri,
    dispose(): void {
      didChangeInlayHintsEmitter.dispose();
      decoratedSnippetsByDocumentUri.clear();
    }
  };
}

/* Stores decorated snippets for one document and signals VS Code so preview marker inlay hints refresh after rendering changes complete. */
export function setLatexInlayHintsForDocument(
  controller: LatexInlayHintController,
  document: vscode.TextDocument,
  decoratedSnippets: DecoratedLatexSnippet[]
): void {
  controller.decoratedSnippetsByDocumentUri.set(document.uri.toString(), decoratedSnippets);
  controller.didChangeInlayHintsEmitter.fire();
}

/* Clears preview marker inlay hints for one document and signals VS Code after a document closes or Texcomment disables there. */
export function clearLatexInlayHintsForDocument(controller: LatexInlayHintController, document: vscode.TextDocument): void {
  controller.decoratedSnippetsByDocumentUri.delete(document.uri.toString());
  controller.didChangeInlayHintsEmitter.fire();
}

/* Creates the VS Code provider that converts cached rendered snippets into hoverable preview marker inlay hints on demand later. */
function createLatexInlayHintsProvider(
  decoratedSnippetsByDocumentUri: Map<string, DecoratedLatexSnippet[]>,
  didChangeInlayHintsEmitter: vscode.EventEmitter<void>
): vscode.InlayHintsProvider {
  return {
    onDidChangeInlayHints: didChangeInlayHintsEmitter.event,
    provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
      return createLatexInlayHintsForDocument(document, range, decoratedSnippetsByDocumentUri);
    }
  };
}

/* Creates preview marker inlay hints for a visible document range using only rendered snippets that are not actively edited now. */
function createLatexInlayHintsForDocument(
  document: vscode.TextDocument,
  range: vscode.Range,
  decoratedSnippetsByDocumentUri: Map<string, DecoratedLatexSnippet[]>
): vscode.InlayHint[] {
  const decoratedSnippets = decoratedSnippetsByDocumentUri.get(document.uri.toString());
  const inlayHints: vscode.InlayHint[] = [];
  if (decoratedSnippets === undefined) {
    return inlayHints;
  }

  for (const decoratedSnippet of decoratedSnippets) {
    const inlayHint = createPreviewMarkerInlayHint(decoratedSnippet, range);
    if (inlayHint === undefined) {
      continue;
    }

    inlayHints.push(inlayHint);
  }

  return inlayHints;
}

/* Creates a hoverable inlay hint marker for one rendered snippet when its position is inside the requested editor range now. */
function createPreviewMarkerInlayHint(decoratedSnippet: DecoratedLatexSnippet, range: vscode.Range): vscode.InlayHint | undefined {
  if (!shouldShowPreviewMarkerInlayHint(decoratedSnippet)) {
    return undefined;
  }

  const renderResult = decoratedSnippet.renderResult;
  if (!isRenderedSnippetResult(renderResult)) {
    return undefined;
  }

  const markerPosition = decoratedSnippet.snippet.range.end;
  if (!range.contains(markerPosition)) {
    return undefined;
  }

  const markerParts = createPreviewMarkerLabelPart(renderResult);
  const inlayHint = new vscode.InlayHint(markerPosition, markerParts, vscode.InlayHintKind.Type);
  return inlayHint;
}

/* Checks whether a snippet should show a preview marker, hiding markers while users actively edit the source line there. */
function shouldShowPreviewMarkerInlayHint(decoratedSnippet: DecoratedLatexSnippet): boolean {
  if (decoratedSnippet.isSourceLineSelected) {
    return false;
  }

  return true;
}

/* Creates the visible preview marker label part with a tooltip and command so VS Code treats it as interactive UI. */
function createPreviewMarkerLabelPart(renderResult: LatexRenderResult): vscode.InlayHintLabelPart[] {
  const tooltip = createLatexPreviewHoverMessage(renderResult);
  return ["", "ⓘ", ""].map(char => {
    const part = new vscode.InlayHintLabelPart(char);
    part.tooltip = tooltip;
    return part;
  });
}

/* Builds an image-only hover message for rendered LaTeX so hovering a preview marker shows the larger SVG nearby in editors. */
function createLatexPreviewHoverMessage(renderResult: LatexRenderResult): vscode.MarkdownString {
  const hoverMessage = new vscode.MarkdownString();
  hoverMessage.isTrusted = false;
  hoverMessage.supportHtml = true;
  const hoverSvgDataUri = readThemeHoverSvgDataUri(renderResult);
  if (hoverSvgDataUri !== undefined) {
    hoverMessage.appendMarkdown("<img alt=\"Rendered LaTeX preview\" src=\"" + hoverSvgDataUri + "\">\n\n");
  }

  return hoverMessage;
}

/* Chooses the embedded hover SVG data URI that matches the active VS Code color theme while skipping unavailable render results. */
function readThemeHoverSvgDataUri(renderResult: LatexRenderResult | undefined): string | undefined {
  if (!isRenderedSnippetResult(renderResult)) {
    return undefined;
  }

  if (isDarkTheme(vscode.window.activeColorTheme.kind)) {
    return renderResult.darkHoverSvgDataUri;
  }

  return renderResult.lightHoverSvgDataUri;
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

/* Checks whether the active color theme should use dark SVG glyph colors for larger hover previews shown beside the cursor. */
function isDarkTheme(themeKind: vscode.ColorThemeKind): boolean {
  if (themeKind === vscode.ColorThemeKind.Dark) {
    return true;
  }

  if (themeKind === vscode.ColorThemeKind.HighContrast) {
    return true;
  }

  return false;
}
