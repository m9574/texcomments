import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import { LatexEnvironmentStatus } from "./types";

const executeFile = promisify(execFile);

const latexExecutablePath = "latex";
const svgConverterPath = "dvisvgm";
const commandTimeoutMilliseconds = 5000;

interface ResolvedCommand {
  isAvailable: boolean;
  executablePath: string;
  discoveryMethod: string;
  checkedCommands: string[];
}

interface CommandLookupResult {
  resolvedPath: string;
  discoveryMethod: string;
  checkedCommand: string;
}

/* Searches for required rendering commands through direct process lookup and platform command lookup during activation and refresh commands on desktop systems. */
export async function findLatexEnvironment(): Promise<LatexEnvironmentStatus> {
  const checkedCommands: string[] = [];
  const latexCommand = await resolveCommandPath(latexExecutablePath);
  appendCheckedCommands(checkedCommands, latexCommand.checkedCommands);

  if (!latexCommand.isAvailable) {
    return {
      isAvailable: false,
      executablePath: "",
      svgConverterPath: "",
      checkedCommands,
      discoveryMethod: latexCommand.discoveryMethod,
      message: "No latex command was found through the Extension Host path or platform command lookup."
    };
  }

  const svgCommand = await resolveCommandPath(svgConverterPath);
  appendCheckedCommands(checkedCommands, svgCommand.checkedCommands);

  if (!svgCommand.isAvailable) {
    return {
      isAvailable: false,
      executablePath: latexCommand.executablePath,
      svgConverterPath: "",
      checkedCommands,
      discoveryMethod: svgCommand.discoveryMethod,
      message: "The latex command was found, but dvisvgm was not found through platform command lookup."
    };
  }

  return {
    isAvailable: true,
    executablePath: latexCommand.executablePath,
    svgConverterPath: svgCommand.executablePath,
    checkedCommands,
    discoveryMethod: createCombinedDiscoveryMethod(latexCommand, svgCommand),
    message: "Usable latex and dvisvgm commands were found."
  };
}

/* Resolves one required command by first testing Extension Host lookup and then asking the platform command lookup before reporting status. */
async function resolveCommandPath(commandName: string): Promise<ResolvedCommand> {
  const checkedCommands: string[] = [];
  checkedCommands.push(commandName + " --version");

  const canRunDirectCommand = await canRunCommand(commandName, ["--version"]);
  if (canRunDirectCommand) {
    return {
      isAvailable: true,
      executablePath: commandName,
      discoveryMethod: "extension-host-path",
      checkedCommands
    };
  }

  const lookupResult = await resolveCommandWithPlatformLookup(commandName);
  checkedCommands.push(lookupResult.checkedCommand);

  if (lookupResult.resolvedPath.length === 0) {
    return {
      isAvailable: false,
      executablePath: "",
      discoveryMethod: "not-found",
      checkedCommands
    };
  }

  checkedCommands.push(lookupResult.resolvedPath + " --version");
  const canRunResolvedCommand = await canRunCommand(lookupResult.resolvedPath, ["--version"]);
  if (canRunResolvedCommand) {
    return {
      isAvailable: true,
      executablePath: lookupResult.resolvedPath,
      discoveryMethod: lookupResult.discoveryMethod,
      checkedCommands
    };
  }

  return {
    isAvailable: false,
    executablePath: "",
    discoveryMethod: "login-shell-path-invalid",
    checkedCommands
  };
}

/* Executes one command with a simple version flag to confirm the executable exists and can be launched by Texcomment safely. */
async function canRunCommand(executablePath: string, commandArguments: string[]): Promise<boolean> {
  try {
    await executeFile(executablePath, commandArguments, {
      timeout: commandTimeoutMilliseconds
    });
    return true;
  } catch {
    return false;
  }
}

/* Resolves a command through the platform's secondary lookup mechanism after direct Extension Host lookup fails on Windows, macOS, and Linux. */
async function resolveCommandWithPlatformLookup(commandName: string): Promise<CommandLookupResult> {
  if (process.platform === "win32") {
    return resolveCommandWithWindowsWhere(commandName);
  }

  return resolveCommandWithUnixShell(commandName);
}

/* Asks where.exe to resolve a command path on Windows, matching the normal executable lookup behavior there before rendering begins safely. */
async function resolveCommandWithWindowsWhere(commandName: string): Promise<CommandLookupResult> {
  try {
    const result = await executeFile("where.exe", [commandName], {
      timeout: commandTimeoutMilliseconds
    });
    return {
      resolvedPath: readFirstOutputLine(result.stdout),
      discoveryMethod: "windows-where",
      checkedCommand: "where.exe " + commandName
    };
  } catch {
    return {
      resolvedPath: "",
      discoveryMethod: "windows-where",
      checkedCommand: "where.exe " + commandName
    };
  }
}

/* Asks the user's Unix shell to resolve a command path, covering macOS and Linux path configuration when editor environments are limited. */
async function resolveCommandWithUnixShell(commandName: string): Promise<CommandLookupResult> {
  const shellExecutablePath = readShellExecutablePath();
  const shellArguments = createShellCommandArguments(shellExecutablePath, "command -v " + commandName);

  try {
    const result = await executeFile(shellExecutablePath, shellArguments, {
      timeout: commandTimeoutMilliseconds
    });
    return {
      resolvedPath: readFirstOutputLine(result.stdout),
      discoveryMethod: "unix-shell-path",
      checkedCommand: shellExecutablePath + " " + shellArguments.join(" ")
    };
  } catch {
    return {
      resolvedPath: "",
      discoveryMethod: "unix-shell-path",
      checkedCommand: shellExecutablePath + " " + shellArguments.join(" ")
    };
  }
}

/* Reads the user's shell path from the environment and falls back to zsh on macOS or sh on Linux systems. */
function readShellExecutablePath(): string {
  const shellExecutablePath = process.env.SHELL;
  if (shellExecutablePath !== undefined && shellExecutablePath.length > 0) {
    return shellExecutablePath;
  }

  if (process.platform === "darwin") {
    return "/bin/zsh";
  }

  return "/bin/sh";
}

/* Creates shell arguments that prefer login shells when supported while preserving compatibility with plain sh on Unix systems during command resolution. */
function createShellCommandArguments(shellExecutablePath: string, commandText: string): string[] {
  const shellBaseName = path.basename(shellExecutablePath);
  if (supportsLoginShellFlag(shellBaseName)) {
    return [
      "-l",
      "-c",
      commandText
    ];
  }

  return [
    "-c",
    commandText
  ];
}

/* Detects shells that commonly support the login flag needed to load user path configuration before command lookup execution begins safely. */
function supportsLoginShellFlag(shellBaseName: string): boolean {
  if (shellBaseName === "bash") {
    return true;
  }

  if (shellBaseName === "zsh") {
    return true;
  }

  if (shellBaseName === "fish") {
    return true;
  }

  return false;
}

/* Reads the first non-empty command lookup line and trims surrounding whitespace from command lookup output safely for path validation later. */
function readFirstOutputLine(outputText: string): string {
  const outputLines = outputText.split(/\r\n|\r|\n/);

  for (const outputLine of outputLines) {
    const trimmedOutputLine = outputLine.trim();
    if (trimmedOutputLine.length > 0) {
      return trimmedOutputLine;
    }
  }

  return "";
}

/* Appends checked command labels from one resolver result into the aggregate environment diagnostics list for prompt details during troubleshooting sessions. */
function appendCheckedCommands(checkedCommands: string[], commandsToAppend: string[]): void {
  for (const commandToAppend of commandsToAppend) {
    checkedCommands.push(commandToAppend);
  }
}

/* Combines command discovery labels into a concise status string that can explain successful environment detection in diagnostic messages for users. */
function createCombinedDiscoveryMethod(latexCommand: ResolvedCommand, svgCommand: ResolvedCommand): string {
  if (latexCommand.discoveryMethod === svgCommand.discoveryMethod) {
    return latexCommand.discoveryMethod;
  }

  return latexCommand.discoveryMethod + "," + svgCommand.discoveryMethod;
}
