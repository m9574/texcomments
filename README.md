# Texcomments
Texcomment is a VS Code extension for displaying LaTeX math snippets that programmers write inside source-code comments. 

## Other Information
### GitHub Link
https://github.com/m9574/texcomments

### How I Built This
I built this with an AI. But, I wasn't blind to the entire process. The tool essentially checks for a local LaTeX installation on your computer, renders the LaTeX math expression snippet in a temporary document, converts that into an SVG and then pastes the SVG into VSCode with some decorations. 

I've included the AGENTS.md file that I used to generate and work on this project in the GitHub repository. This file was not AI generated. But every line of code here is. Although, I had to make some manual edits when I ran out of tokens.

### Bugs:
1. There's a delay when hovering between snippets, which causes one of the snippets to not render properly.
2. The rendered math equations are quite small because VSCode won't let me change the height of a single line. It's also why only inline LaTeX expression are supported.
3. The hover preview image covers the text right below it, which could be inconvenient.
4. You need a LaTeX installation on your computer, the extension does search for it, and it works on Mac and Windows (presumably).
