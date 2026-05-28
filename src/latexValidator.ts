import { LatexValidationResult } from "./types";

const maximumSnippetCharacters = 2000;
const maximumSnippetLines = 12;

const blockedDocumentCommands = [
  "\\documentclass",
  "\\usepackage",
  "\\begin{document}",
  "\\end{document}",
  "\\title",
  "\\author",
  "\\date",
  "\\maketitle",
  "\\tableofcontents",
  "\\newcommand",
  "\\renewcommand",
  "\\def"
];

const allowedSnippetEnvironments = [
  "aligned",
  "alignedat",
  "array",
  "bmatrix",
  "Bmatrix",
  "cases",
  "gathered",
  "matrix",
  "pmatrix",
  "smallmatrix",
  "split",
  "vmatrix",
  "Vmatrix"
];

/* Validates one inline LaTeX math snippet by checking size, document commands, balanced delimiters, and supported environments before preview rendering starts. */
export function validateLatexSnippet(body: string): LatexValidationResult {
  if (!hasNonWhitespaceContent(body)) {
    return createInvalidValidationResult("The LaTeX snippet is empty.");
  }

  if (body.length > maximumSnippetCharacters) {
    return createInvalidValidationResult("The LaTeX snippet is too long for source-code rendering.");
  }

  if (countSnippetLines(body) > maximumSnippetLines) {
    return createInvalidValidationResult("The LaTeX snippet has too many lines and may be a document fragment.");
  }

  if (containsBlockedDocumentCommand(body)) {
    return createInvalidValidationResult("Document-level LaTeX commands are not allowed inside source-code comments.");
  }

  if (containsUnsupportedEnvironment(body)) {
    return createInvalidValidationResult("Only common mathematical snippet environments are supported in comments.");
  }

  if (!hasBalancedBraces(body)) {
    return createInvalidValidationResult("The LaTeX snippet has unbalanced braces.");
  }

  if (!hasBalancedBrackets(body)) {
    return createInvalidValidationResult("The LaTeX snippet has unbalanced brackets.");
  }

  if (containsUnexpectedDollar(body)) {
    return createInvalidValidationResult("Nested dollar delimiters are not allowed inside one LaTeX snippet.");
  }

  return createValidValidationResult();
}

/* Creates a successful validation result so calling modules share one obvious representation of accepted snippets across diagnostics, hovers, and decorations. */
export function createValidValidationResult(): LatexValidationResult {
  return {
    isValid: true,
    message: "The LaTeX snippet is valid."
  };
}

/* Creates a failed validation result with a readable message that can be shown in diagnostics, hovers, and editor decorations later. */
export function createInvalidValidationResult(message: string): LatexValidationResult {
  return {
    isValid: false,
    message
  };
}

/* Checks whether the snippet contains meaningful text after whitespace is removed, preventing empty math delimiters from rendering in editor previews. */
function hasNonWhitespaceContent(body: string): boolean {
  const trimmedBody = body.trim();
  if (trimmedBody.length > 0) {
    return true;
  }

  return false;
}

/* Counts the snippet line breaks using a straightforward split, supporting a simple size limit without parsing complete documents inside comments. */
function countSnippetLines(body: string): number {
  const snippetLines = body.split(/\r\n|\r|\n/);
  return snippetLines.length;
}

/* Looks for document-level commands that would move Texcomment beyond snippets and into unsafe embedded LaTeX documents inside source comments entirely. */
function containsBlockedDocumentCommand(body: string): boolean {
  for (const blockedCommand of blockedDocumentCommands) {
    if (body.includes(blockedCommand)) {
      return true;
    }
  }

  return false;
}

/* Detects environment usage outside the small mathematical environments expected inside comment-based equation snippets before rendering is attempted by Texcomment later. */
function containsUnsupportedEnvironment(body: string): boolean {
  const beginEnvironmentPattern = /\\begin\{([^}]+)\}/g;
  let match = beginEnvironmentPattern.exec(body);

  while (match !== null) {
    const environmentName = match[1];
    if (!isAllowedSnippetEnvironment(environmentName)) {
      return true;
    }

    match = beginEnvironmentPattern.exec(body);
  }

  return false;
}

/* Compares an environment name against the supported mathematical snippet list using an explicit readable loop for maintainability during validation checks. */
function isAllowedSnippetEnvironment(environmentName: string): boolean {
  for (const allowedEnvironment of allowedSnippetEnvironments) {
    if (environmentName === allowedEnvironment) {
      return true;
    }
  }

  return false;
}

/* Verifies curly braces balance while treating escaped brace characters as literal content rather than structural syntax during validation for snippets. */
function hasBalancedBraces(body: string): boolean {
  let braceDepth = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (isEscapedCharacter(body, index)) {
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
    }

    if (character === "}") {
      braceDepth -= 1;
    }

    if (braceDepth < 0) {
      return false;
    }
  }

  if (braceDepth === 0) {
    return true;
  }

  return false;
}

/* Verifies square brackets balance so optional arguments have basic syntax coverage before snippets are rendered in the editor preview layer. */
function hasBalancedBrackets(body: string): boolean {
  let bracketDepth = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (isEscapedCharacter(body, index)) {
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
    }

    if (character === "]") {
      bracketDepth -= 1;
    }

    if (bracketDepth < 0) {
      return false;
    }
  }

  if (bracketDepth === 0) {
    return true;
  }

  return false;
}

/* Finds unescaped dollar characters inside an already delimited inline snippet, preventing ambiguous nested math regions before rendering begins safely later. */
function containsUnexpectedDollar(body: string): boolean {
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "$") {
      continue;
    }

    if (isEscapedCharacter(body, index)) {
      continue;
    }

    return true;
  }

  return false;
}

/* Determines whether a character is escaped by counting consecutive preceding backslashes at the supplied string index during delimiter parsing checks. */
function isEscapedCharacter(text: string, characterIndex: number): boolean {
  let backslashCount = 0;

  for (let index = characterIndex - 1; index >= 0; index -= 1) {
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
