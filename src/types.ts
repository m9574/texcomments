import * as vscode from "vscode";

export interface LatexValidationResult {
  isValid: boolean;
  message: string;
}

export interface LatexSnippet {
  source: string;
  body: string;
  range: vscode.Range;
  contentRange: vscode.Range;
  validation: LatexValidationResult;
}

export interface CommentSegment {
  text: string;
  lineNumber: number;
  startCharacter: number;
}

export interface LatexEnvironmentStatus {
  isAvailable: boolean;
  executablePath: string;
  svgConverterPath: string;
  checkedCommands: string[];
  discoveryMethod: string;
  message: string;
}

export interface LatexRenderResult {
  cacheKey: string;
  isRendered: boolean;
  lightSvgUri: vscode.Uri | undefined;
  darkSvgUri: vscode.Uri | undefined;
  lightHoverSvgUri: vscode.Uri | undefined;
  darkHoverSvgUri: vscode.Uri | undefined;
  lightHoverSvgDataUri: string | undefined;
  darkHoverSvgDataUri: string | undefined;
  message: string;
}

export interface DecoratedLatexSnippet {
  snippet: LatexSnippet;
  renderResult: LatexRenderResult | undefined;
  isSourceLineSelected: boolean;
}
