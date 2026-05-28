import * as vscode from "vscode";
import { createInvalidValidationResult, validateLatexSnippet } from "./latexValidator";
import { CommentSegment, LatexSnippet, LatexValidationResult } from "./types";

interface BlockCommentMarker {
  startMarker: string;
  endMarker: string;
}

interface BlockCommentMatch {
  startIndex: number;
  marker: BlockCommentMarker;
}

const lineCommentMarkers = [
  "//",
  "#",
  "--",
  "%",
  ";"
];

const blockCommentMarkers: BlockCommentMarker[] = [
  {
    startMarker: "/*",
    endMarker: "*/"
  },
  {
    startMarker: "<!--",
    endMarker: "-->"
  }
];

/* Scans a VS Code text document for supported LaTeX snippets that appear within broadly recognized line or block comment regions. */
export function scanDocumentForLatexSnippets(document: vscode.TextDocument): LatexSnippet[] {
  const commentSegments = collectCommentSegments(document);
  const snippets: LatexSnippet[] = [];

  for (const commentSegment of commentSegments) {
    const segmentSnippets = findLatexSnippetsInSegment(commentSegment);
    for (const snippet of segmentSnippets) {
      snippets.push(snippet);
    }
  }

  return snippets;
}

/* Collects possible source-code comment regions across a document using common markers shared by many programming languages during scanning for snippets. */
function collectCommentSegments(document: vscode.TextDocument): CommentSegment[] {
  const commentSegments: CommentSegment[] = [];
  let activeBlockEndMarker = "";

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
    const lineText = document.lineAt(lineNumber).text;
    const lineSegments = collectCommentSegmentsFromLine(lineText, lineNumber, activeBlockEndMarker);
    activeBlockEndMarker = lineSegments.activeBlockEndMarker;

    for (const segment of lineSegments.segments) {
      commentSegments.push(segment);
    }
  }

  return commentSegments;
}

/* Extracts all comment segments from one source line while preserving any active block-comment state for following lines in the document. */
function collectCommentSegmentsFromLine(
  lineText: string,
  lineNumber: number,
  activeBlockEndMarker: string
): { segments: CommentSegment[]; activeBlockEndMarker: string } {
  const segments: CommentSegment[] = [];
  let searchStart = 0;
  let currentActiveBlockEndMarker = activeBlockEndMarker;

  if (currentActiveBlockEndMarker.length > 0) {
    const blockEndIndex = lineText.indexOf(currentActiveBlockEndMarker);
    if (blockEndIndex === -1) {
      segments.push(createCommentSegment(lineText, lineNumber, 0, lineText.length));
      return {
        segments,
        activeBlockEndMarker: currentActiveBlockEndMarker
      };
    }

    const segmentEnd = blockEndIndex + currentActiveBlockEndMarker.length;
    segments.push(createCommentSegment(lineText, lineNumber, 0, segmentEnd));
    searchStart = segmentEnd;
    currentActiveBlockEndMarker = "";
  }

  while (searchStart < lineText.length) {
    const lineCommentIndex = findEarliestLineCommentStart(lineText, searchStart);
    const blockCommentMatch = findEarliestBlockCommentStart(lineText, searchStart);

    if (lineCommentIndex === -1 && blockCommentMatch === undefined) {
      break;
    }

    if (shouldUseLineComment(lineCommentIndex, blockCommentMatch)) {
      segments.push(createCommentSegment(lineText, lineNumber, lineCommentIndex, lineText.length));
      break;
    }

    if (blockCommentMatch !== undefined) {
      const blockEndIndex = lineText.indexOf(blockCommentMatch.marker.endMarker, blockCommentMatch.startIndex + blockCommentMatch.marker.startMarker.length);
      if (blockEndIndex === -1) {
        segments.push(createCommentSegment(lineText, lineNumber, blockCommentMatch.startIndex, lineText.length));
        currentActiveBlockEndMarker = blockCommentMatch.marker.endMarker;
        break;
      }

      const segmentEnd = blockEndIndex + blockCommentMatch.marker.endMarker.length;
      segments.push(createCommentSegment(lineText, lineNumber, blockCommentMatch.startIndex, segmentEnd));
      searchStart = segmentEnd;
    }
  }

  return {
    segments,
    activeBlockEndMarker: currentActiveBlockEndMarker
  };
}

/* Creates one comment segment from a source line and records offsets needed to translate snippets into editor ranges precisely for display. */
function createCommentSegment(lineText: string, lineNumber: number, startCharacter: number, endCharacter: number): CommentSegment {
  return {
    text: lineText.substring(startCharacter, endCharacter),
    lineNumber,
    startCharacter
  };
}

/* Chooses whether a line-comment marker appears before any competing block-comment marker on the same source line during scanning for comments. */
function shouldUseLineComment(lineCommentIndex: number, blockCommentMatch: BlockCommentMatch | undefined): boolean {
  if (lineCommentIndex === -1) {
    return false;
  }

  if (blockCommentMatch === undefined) {
    return true;
  }

  if (lineCommentIndex < blockCommentMatch.startIndex) {
    return true;
  }

  return false;
}

/* Finds the earliest common line-comment marker at or after the supplied character offset in a source line reliably during scanning. */
function findEarliestLineCommentStart(lineText: string, searchStart: number): number {
  let earliestIndex = -1;

  for (const lineCommentMarker of lineCommentMarkers) {
    const markerIndex = lineText.indexOf(lineCommentMarker, searchStart);
    if (markerIndex === -1) {
      continue;
    }

    if (earliestIndex === -1 || markerIndex < earliestIndex) {
      earliestIndex = markerIndex;
    }
  }

  return earliestIndex;
}

/* Finds the earliest supported block-comment opening marker and keeps its matching closing marker for later scanning on the line segment. */
function findEarliestBlockCommentStart(lineText: string, searchStart: number): BlockCommentMatch | undefined {
  let earliestMatch: BlockCommentMatch | undefined = undefined;

  for (const blockCommentMarker of blockCommentMarkers) {
    const markerIndex = lineText.indexOf(blockCommentMarker.startMarker, searchStart);
    if (markerIndex === -1) {
      continue;
    }

    if (earliestMatch === undefined || markerIndex < earliestMatch.startIndex) {
      earliestMatch = {
        startIndex: markerIndex,
        marker: blockCommentMarker
      };
    }
  }

  return earliestMatch;
}

/* Finds closed or incomplete inline LaTeX snippets inside one comment segment while ignoring unsupported display math delimiters during document scanning. */
function findLatexSnippetsInSegment(segment: CommentSegment): LatexSnippet[] {
  const snippets: LatexSnippet[] = [];
  let searchStart = 0;

  while (searchStart < segment.text.length) {
    const openingIndex = findNextInlineOpeningDelimiter(segment.text, searchStart);
    if (openingIndex === -1) {
      break;
    }

    const bodyStartIndex = openingIndex + 1;
    const closingIndex = findClosingInlineDelimiter(segment.text, bodyStartIndex);

    if (closingIndex === -1) {
      const invalidValidation = createInvalidValidationResult("The LaTeX snippet is missing a closing dollar delimiter.");
      snippets.push(createLatexSnippet(segment, openingIndex, segment.text.length, invalidValidation));
      break;
    }

    const body = segment.text.substring(bodyStartIndex, closingIndex);
    const validation = validateLatexSnippet(body);
    snippets.push(createLatexSnippet(segment, openingIndex, closingIndex + 1, validation));
    searchStart = closingIndex + 1;
  }

  return snippets;
}

/* Finds the next unescaped single dollar that can start inline LaTeX while skipping unsupported display math dollar pairs completely there. */
function findNextInlineOpeningDelimiter(text: string, searchStart: number): number {
  for (let index = searchStart; index < text.length; index += 1) {
    if (!isSingleDollarDelimiter(text, index)) {
      continue;
    }

    return index;
  }

  return -1;
}

/* Finds the matching unescaped single dollar closing delimiter for one inline snippet inside a comment text segment during parsing passes. */
function findClosingInlineDelimiter(text: string, searchStart: number): number {
  for (let index = searchStart; index < text.length; index += 1) {
    if (!isSingleDollarDelimiter(text, index)) {
      continue;
    }

    return index;
  }

  return -1;
}

/* Determines whether one dollar character is usable as an inline delimiter by rejecting adjacent display-math dollars during scanning before parsing. */
function isSingleDollarDelimiter(text: string, dollarIndex: number): boolean {
  if (text[dollarIndex] !== "$") {
    return false;
  }

  const previousIndex = dollarIndex - 1;
  if (previousIndex >= 0 && text[previousIndex] === "$") {
    return false;
  }

  const nextIndex = dollarIndex + 1;
  if (nextIndex < text.length && text[nextIndex] === "$") {
    return false;
  }

  return true;
}

/* Creates an editor-aware LaTeX snippet object by translating segment-relative indexes into VS Code ranges for decorations and diagnostics later on. */
function createLatexSnippet(
  segment: CommentSegment,
  startIndex: number,
  endIndex: number,
  validation: LatexValidationResult
): LatexSnippet {
  const bodyStartIndex = startIndex + 1;
  const bodyEndIndex = endIndex - 1;
  const range = new vscode.Range(
    segment.lineNumber,
    segment.startCharacter + startIndex,
    segment.lineNumber,
    segment.startCharacter + endIndex
  );
  const contentRange = new vscode.Range(
    segment.lineNumber,
    segment.startCharacter + bodyStartIndex,
    segment.lineNumber,
    segment.startCharacter + bodyEndIndex
  );

  return {
    source: segment.text.substring(startIndex, endIndex),
    body: segment.text.substring(bodyStartIndex, bodyEndIndex),
    range,
    contentRange,
    validation
  };
}

/* Determines whether a dollar delimiter is escaped by an odd number of immediately preceding backslashes during snippet parsing checks now. */
function isEscapedDollar(text: string, dollarIndex: number): boolean {
  let backslashCount = 0;

  for (let index = dollarIndex - 1; index >= 0; index -= 1) {
    if (text[index] !== "\\") {
      break;
    }

    backslashCount += 1;
  }

  if (backslashCount % 2 === 1) {
    return true;
  }

  return false;
}
