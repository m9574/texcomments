## Project Description
We will be building 'texcomment', a VSCode extension that allows programmers to render mathematical statements written in LaTeX directly on their source code. 

## Requirements
- For any programming language, a user should be able to write a mathematical expression with Tex code as a comment in their source code. This expression should be displayed directly in their source code editor. 
- Writing this mathematical expression should not break the code nor should it cause any compilation or runtime errors. It must be treated like any other comment in a computer program.
- The mathematical expression must begin and end with a '$' or '$$' sign. There must be a simple syntax checker to check the validity of the statement. 
- The mathematical packages the extension supports are the following: amsmath, amssymb, amsthm, amsfonts. The rendering of our expressions will rely on the existing packages and the minimal LaTeX package mentioned in the last sentence. 
- In the installation of this extension, users must have LaTeX installed in their system. The extension will look for the path where LaTeX is installed and use those instead. If the user does not have LaTeX installed, it must be prompted to do so. 
- The rendering of the equations may be long but it must be visible and have appropriate contast with the background of the editor whether it is in light or dark or a custom mode. 
- Once the programmer has typed their LaTeX comment in, the expression should render if their cursor is no longer acive on the comment itself. If the programmer clicks on the rendered expression, it should direct them to the location of the typed comment. 
- Users should not be allowed to create entire documents in their source code. Only snippets are permitted. 
- The extension must be able to be toggled on and off directly in the editor. This means it must have a small icon on the top right corner of the source code editor, which users can click to activate or deactivate the extension. 

## Tech-Stack 
- We will primarily rely on TypeScript for it's ease of use, support, and strong-ness. 

## Coding Style Requirements
- We will follow the functional programming approach. Each function has one specific purpose with a descriptive name. Above each function add a small comment on what the function achieves with at least 20 words but no more than 30 words. 
- Avoid 'clever' and 'tricky' pieces of code as it impacts readability. Strive to code with verbosity to provide more clarity for the developer. 
- Never use ternary or list comprehensions to shorten code. 

## Development Workflow Guidelines
- Before writing and/or deleting any code, you must tell me breifly the purpose of the edit and what files you intend to edit.
- I will response with an OK or NOT OK. 
    - OK means you may proceed with your edits.
    - NOT OK means one of the two things
        1. I don't approve of your edits, in this case you must come up with a different approach to the problem. Afterwards ask me again OK or NOT OK, and the process will repeat.
        2. I don't understand the edits, in this case you must explain to me why you think your approach is the best and point me to resources to learn more about your approach. Afterwards ask me again OK or NOT OK, and the process will repeat.
- Before installing any libraries, you will consult me the packages you wish to install.