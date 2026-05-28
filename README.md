# Texcomment

Texcomment is a VS Code extension for displaying LaTeX math snippets that programmers write inside source-code comments.

This first build provides the extension skeleton and a conservative editor experience:

- Toggle Texcomment from the editor title bar or command palette.
- Detect `$...$` inline snippets and `$$...$$` display snippets inside common line and block comments.
- Validate snippets for empty content, unmatched braces, unmatched brackets, nested dollar delimiters, unsupported environments, and document-level commands.
- Check for `latex` and `dvisvgm` on the Extension Host path, then through platform command lookup, and prompt when required rendering tools are missing.
- Render valid snippets to SVG previews with light and dark theme variants.
- Visually replace inactive TeX snippets with rendered math while keeping the source clickable for editing.
- Render display math with block-style previews that visually separate equations from surrounding source text.
- Stay visually quiet while rendering is pending, so source comments do not flash temporary `TeX: ...` preview labels.
- Show hover details and diagnostics without adding extra preview text above comments.
- Hide inline previews when selected, while selected display math keeps source visible with a block preview.

## Development

Install dependencies:

```sh
npm install
```

Compile the extension:

```sh
npm run compile
```

Run type checking without writing output:

```sh
npm run check
```

## Rendering Requirements

Texcomment currently renders through system commands. Both commands should be available from the VS Code Extension Host or the platform command lookup:

```sh
latex --version
dvisvgm --version
```

MacTeX usually provides both tools. On Windows, Texcomment falls back to `where.exe`; on macOS and Linux, it falls back to the user's shell command lookup.
