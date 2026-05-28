import * as vscode from "vscode";
import { scanDocumentForLatexSnippets } from "./commentScanner";
import { applyLatexDecorations, clearLatexDecorations, createLatexDecorationTypes, LatexDecorationTypes } from "./editorDecorations";
import { findLatexEnvironment } from "./latexEnvironment";
import { clearLatexInlayHintsForDocument, createLatexInlayHintController, LatexInlayHintController, latexPreviewMarkerCommand, setLatexInlayHintsForDocument } from "./latexInlayHints";
import { createLatexRenderCache, createLatexRenderCacheKey, createLatexRenderSettings, LatexRenderCache, LatexRenderSettings, renderLatexSnippets } from "./latexRenderer";
import { DecoratedLatexSnippet, LatexEnvironmentStatus, LatexRenderResult, LatexSnippet } from "./types";

const defaultEditorFontSizePixels = 14;

interface RuntimeState {
  context: vscode.ExtensionContext;
  decorationTypes: LatexDecorationTypes;
  diagnosticCollection: vscode.DiagnosticCollection;
  inlayHintController: LatexInlayHintController;
  renderCache: LatexRenderCache;
  documentRefreshTokens: Map<string, number>;
  enabled: boolean;
  latexEnvironment: LatexEnvironmentStatus | undefined;
  hasPromptedForLatex: boolean;
}

let runtimeState: RuntimeState | undefined = undefined;

/* Activates Texcomment by creating shared editor resources, registering commands, checking LaTeX availability, and rendering current editors during extension startup safely. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const decorationTypes = createLatexDecorationTypes();
  const diagnosticCollection = vscode.languages.createDiagnosticCollection("texcomment");
  const inlayHintController = createLatexInlayHintController();
  const renderCache = createLatexRenderCache(context);
  const enabled = readInitialEnabledState(context);

  runtimeState = {
    context,
    decorationTypes,
    diagnosticCollection,
    inlayHintController,
    renderCache,
    documentRefreshTokens: new Map<string, number>(),
    enabled,
    latexEnvironment: undefined,
    hasPromptedForLatex: false
  };

  context.subscriptions.push(decorationTypes.hiddenInline);
  context.subscriptions.push(decorationTypes.renderedInline);
  context.subscriptions.push(decorationTypes.activeInline);
  context.subscriptions.push(decorationTypes.invalid);
  context.subscriptions.push(diagnosticCollection);
  context.subscriptions.push(inlayHintController);
  context.subscriptions.push(vscode.languages.registerInlayHintsProvider(createLatexInlayHintSelector(), inlayHintController.provider));

  registerExtensionCommands(context);
  registerEditorListeners(context);
  await vscode.commands.executeCommand("setContext", "texcomment.enabled", enabled);
  await initializeLatexEnvironment(false);
  refreshAllVisibleEditors();
}

/* Deactivates Texcomment by allowing VS Code subscriptions to dispose resources and clearing the module-level runtime reference for future activation cycles. */
export function deactivate(): void {
  runtimeState = undefined;
}

/* Reads the saved user toggle first, then falls back to workspace configuration defaults when Texcomment activates for the first time. */
function readInitialEnabledState(context: vscode.ExtensionContext): boolean {
  const savedEnabledState = context.workspaceState.get<boolean>("texcomment.enabled");
  if (savedEnabledState !== undefined) {
    return savedEnabledState;
  }

  const configuration = vscode.workspace.getConfiguration("texcomment");
  return configuration.get<boolean>("enabledByDefault", true);
}

/* Registers user-facing commands for toggling and refreshing Texcomment in the active workspace session from available command surfaces inside VS Code. */
function registerExtensionCommands(context: vscode.ExtensionContext): void {
  const toggleCommand = vscode.commands.registerCommand("texcomment.toggle", handleToggleCommand);
  const refreshCommand = vscode.commands.registerCommand("texcomment.refresh", handleRefreshCommand);
  const previewMarkerCommand = vscode.commands.registerCommand(latexPreviewMarkerCommand, handlePreviewMarkerCommand);

  context.subscriptions.push(toggleCommand);
  context.subscriptions.push(refreshCommand);
  context.subscriptions.push(previewMarkerCommand);
}

/* Handles preview marker clicks as a no-op so inlay hint label parts render as interactive hoverable UI without changing files. */
function handlePreviewMarkerCommand(): void {
  return;
}

/* Creates a broad document selector so Texcomment preview marker inlay hints can appear in source files across programming languages consistently. */
function createLatexInlayHintSelector(): vscode.DocumentSelector {
  const selector: vscode.DocumentFilter[] = [];
  selector.push({
    scheme: "file"
  });
  selector.push({
    scheme: "untitled"
  });
  return selector;
}

/* Registers editor and document listeners so previews update as users type, switch files, move cursors, or close documents inside VS Code. */
function registerEditorListeners(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(handleActiveEditorChanged));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(handleTextDocumentChanged));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(handleSelectionChanged));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(handleConfigurationChanged));
  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(handleActiveColorThemeChanged));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(handleDocumentClosed));
}

/* Toggles Texcomment for the workspace, persists the choice, refreshes every visible editor, and updates the editor command state after users click the icon. */
async function handleToggleCommand(): Promise<void> {
  const state = runtimeState;
  if (state === undefined) {
    return;
  }

  state.enabled = !state.enabled;
  await state.context.workspaceState.update("texcomment.enabled", state.enabled);
  await vscode.commands.executeCommand("setContext", "texcomment.enabled", state.enabled);

  let message = "Texcomment enabled.";
  if (!state.enabled) {
    message = "Texcomment disabled.";
  }

  vscode.window.showInformationMessage(message);
  refreshAllVisibleEditors();
}

/* Rechecks LaTeX availability and rerenders visible editors when the user manually asks Texcomment to refresh the current workspace state again. */
async function handleRefreshCommand(): Promise<void> {
  await initializeLatexEnvironment(true);
  refreshAllVisibleEditors();
}

/* Refreshes the newly active editor whenever the user changes focus between open documents in VS Code during normal editing sessions. */
function handleActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
  if (editor !== undefined) {
    void refreshEditor(editor);
  }
}

/* Refreshes presentation for visible editors whose document content changed after typing, saving, formatting, or receiving external file updates from disk. */
function handleTextDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === event.document.uri.toString()) {
      void refreshEditor(editor);
    }
  }
}

/* Refreshes decorations as cursor movement determines whether an active snippet should remain rendered, become editable, or hide previews during editing. */
function handleSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
  void refreshEditor(event.textEditor);
}

/* Refreshes rendered SVGs when editor font size changes so physically resized preview files follow source text dimensions immediately after updates. */
function handleConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
  if (event.affectsConfiguration("editor.fontSize")) {
    refreshAllVisibleEditors();
  }
}

/* Refreshes hover markdown after theme changes so larger preview SVGs continue matching light and dark editor backgrounds correctly in editors. */
function handleActiveColorThemeChanged(): void {
  refreshAllVisibleEditors();
}

/* Clears diagnostics for a closed document so stale validation messages do not linger after files disappear from the editor view. */
function handleDocumentClosed(document: vscode.TextDocument): void {
  const state = runtimeState;
  if (state === undefined) {
    return;
  }

  state.diagnosticCollection.delete(document.uri);
  state.documentRefreshTokens.delete(document.uri.toString());
  clearLatexInlayHintsForDocument(state.inlayHintController, document);
}

/* Checks the local machine for LaTeX and prompts the user when no supported executable is available on the system path. */
async function initializeLatexEnvironment(shouldRepeatMissingLatexPrompt: boolean): Promise<void> {
  const state = runtimeState;
  if (state === undefined) {
    return;
  }

  const latexEnvironment = await findLatexEnvironment();
  state.latexEnvironment = latexEnvironment;

  if (!latexEnvironment.isAvailable) {
    await promptForLatexInstallation(shouldRepeatMissingLatexPrompt);
  }
}

/* Shows installation guidance for missing LaTeX, optionally repeating the warning when users explicitly refresh the environment check from VS Code commands. */
async function promptForLatexInstallation(shouldRepeatMissingLatexPrompt: boolean): Promise<void> {
  const state = runtimeState;
  if (state === undefined) {
    return;
  }

  if (state.hasPromptedForLatex && !shouldRepeatMissingLatexPrompt) {
    return;
  }

  state.hasPromptedForLatex = true;
  const installLabel = "Install LaTeX";
  let warningMessage = "Texcomment needs LaTeX rendering tools before full equation rendering can run.";
  if (state.latexEnvironment !== undefined) {
    warningMessage = state.latexEnvironment.message;
  }

  const selectedAction = await vscode.window.showWarningMessage(
    warningMessage,
    installLabel
  );

  if (selectedAction === installLabel) {
    await vscode.env.openExternal(vscode.Uri.parse("https://www.latex-project.org/get/"));
  }
}

/* Refreshes all visible editors, clearing Texcomment presentation from each one when the extension is disabled by the user toggle command. */
function refreshAllVisibleEditors(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    void refreshEditor(editor);
  }
}

/* Scans one editor, applies decorations, and updates diagnostics while respecting the enabled toggle state and currently selected source lines carefully. */
async function refreshEditor(editor: vscode.TextEditor): Promise<void> {
  const state = runtimeState;
  if (state === undefined) {
    return;
  }

  if (!state.enabled) {
    clearEditorPresentation(editor, state);
    return;
  }

  const snippets = scanDocumentForLatexSnippets(editor.document);
  const refreshToken = createDocumentRefreshToken(editor.document);
  const renderSettings = createLatexRenderSettings(readEditorFontSizePixels(editor));
  const fallbackDecoratedSnippets = createDecoratedLatexSnippets(editor, snippets, new Map<string, LatexRenderResult>(), renderSettings);

  applyLatexDecorations(editor, state.decorationTypes, fallbackDecoratedSnippets);
  setLatexInlayHintsForDocument(state.inlayHintController, editor.document, fallbackDecoratedSnippets);
  updateDiagnosticsForDocument(editor.document, snippets);

  const renderResults = await renderLatexSnippets(snippets, state.latexEnvironment, state.renderCache, renderSettings);
  if (!isCurrentDocumentRefreshToken(editor.document, refreshToken)) {
    return;
  }

  const renderedDecoratedSnippets = createDecoratedLatexSnippets(editor, snippets, renderResults, renderSettings);
  applyLatexDecorations(editor, state.decorationTypes, renderedDecoratedSnippets);
  setLatexInlayHintsForDocument(state.inlayHintController, editor.document, renderedDecoratedSnippets);
}

/* Clears Texcomment decorations and diagnostics for one editor when users turn the extension off from any command surface available there. */
function clearEditorPresentation(editor: vscode.TextEditor, state: RuntimeState): void {
  clearLatexDecorations(editor, state.decorationTypes);
  clearLatexInlayHintsForDocument(state.inlayHintController, editor.document);
  state.diagnosticCollection.delete(editor.document.uri);
}

/* Checks all editor selections against one source line so rendered math reveals itself during cursor placement and multiline selections in editors. */
function doesAnySelectionTouchLine(selections: readonly vscode.Selection[], lineNumber: number): boolean {
  for (const selection of selections) {
    if (doesSelectionTouchLine(selection, lineNumber)) {
      return true;
    }
  }

  return false;
}

/* Checks one selection against one line by comparing normalized start and end lines, covering reversed selections from keyboard movement carefully. */
function doesSelectionTouchLine(selection: vscode.Selection, lineNumber: number): boolean {
  let startLine = selection.start.line;
  let endLine = selection.end.line;

  if (selection.end.line < selection.start.line) {
    startLine = selection.end.line;
    endLine = selection.start.line;
  }

  if (lineNumber < startLine) {
    return false;
  }

  if (lineNumber > endLine) {
    return false;
  }

  return true;
}

/* Creates decorated snippet models by matching scanned snippets with rendered SVG results using stable render cache keys for decoration rendering. */
function createDecoratedLatexSnippets(
  editor: vscode.TextEditor,
  snippets: LatexSnippet[],
  renderResults: Map<string, LatexRenderResult>,
  renderSettings: LatexRenderSettings
): DecoratedLatexSnippet[] {
  const decoratedSnippets: DecoratedLatexSnippet[] = [];

  for (const snippet of snippets) {
    const cacheKey = createLatexRenderCacheKey(snippet, renderSettings);
    const renderResult = renderResults.get(cacheKey);
    decoratedSnippets.push({
      snippet,
      renderResult,
      isSourceLineSelected: doesAnySelectionTouchLine(editor.selections, snippet.range.start.line)
    });
  }

  return decoratedSnippets;
}

/* Reads the effective editor font size for one document so render cache keys and SVG dimensions track user configuration changes. */
function readEditorFontSizePixels(editor: vscode.TextEditor): number {
  const configuration = vscode.workspace.getConfiguration("editor", editor.document.uri);
  const configuredFontSize = configuration.get<number>("fontSize", defaultEditorFontSizePixels);
  if (configuredFontSize > 0) {
    return configuredFontSize;
  }

  return defaultEditorFontSizePixels;
}

/* Creates a new per-document refresh token so slower render work cannot apply stale decorations after edits when users type quickly. */
function createDocumentRefreshToken(document: vscode.TextDocument): number {
  const state = runtimeState;
  if (state === undefined) {
    return 0;
  }

  const documentKey = document.uri.toString();
  const existingRefreshToken = state.documentRefreshTokens.get(documentKey);
  let nextRefreshToken = 1;
  if (existingRefreshToken !== undefined) {
    nextRefreshToken = existingRefreshToken + 1;
  }

  state.documentRefreshTokens.set(documentKey, nextRefreshToken);
  return nextRefreshToken;
}

/* Checks whether an asynchronous render pass still matches the latest known refresh token for its document before applying decorations safely. */
function isCurrentDocumentRefreshToken(document: vscode.TextDocument, refreshToken: number): boolean {
  const state = runtimeState;
  if (state === undefined) {
    return false;
  }

  const currentRefreshToken = state.documentRefreshTokens.get(document.uri.toString());
  if (currentRefreshToken === refreshToken) {
    return true;
  }

  return false;
}

/* Replaces diagnostics for one document with current validation results from every scanned LaTeX snippet in the file during refresh cycles. */
function updateDiagnosticsForDocument(document: vscode.TextDocument, snippets: LatexSnippet[]): void {
  const state = runtimeState;
  if (state === undefined) {
    return;
  }

  const diagnostics: vscode.Diagnostic[] = [];
  for (const snippet of snippets) {
    if (snippet.validation.isValid) {
      continue;
    }

    diagnostics.push(createDiagnosticForSnippet(snippet));
  }

  state.diagnosticCollection.set(document.uri, diagnostics);
}

/* Converts a failed snippet validation result into a VS Code diagnostic tied directly to the source range for clear feedback. */
function createDiagnosticForSnippet(snippet: LatexSnippet): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    snippet.range,
    snippet.validation.message,
    vscode.DiagnosticSeverity.Warning
  );

  diagnostic.source = "texcomment";
  return diagnostic;
}
