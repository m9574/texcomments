import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { LatexEnvironmentStatus, LatexRenderResult, LatexSnippet } from "./types";

const executeFile = promisify(execFile);

const latexProcessTimeoutMilliseconds = 10000;
const latexProcessMaximumBufferBytes = 1024 * 1024 * 5;
const defaultEditorFontSizePixels = 14;
const hoverPreviewScaleFactor = 2.6;
const hoverSvgPaddingPoints = 12;
const cssPixelsPerInch = 96;
const texPointsPerInch = 72.27;
const renderStyleVersion = "svg-color-v9-inline-font-size-hover-padding";

export interface LatexRenderCache {
  storageDirectory: string;
  renderPromises: Map<string, Promise<LatexRenderResult>>;
}

export interface LatexRenderSettings {
  inlineSvgHeightPoints: number;
  hoverSvgHeightPoints: number;
}

/* Creates a renderer cache rooted in VS Code storage so generated SVG previews survive refreshes during the same workspace session. */
export function createLatexRenderCache(context: vscode.ExtensionContext): LatexRenderCache {
  return {
    storageDirectory: path.join(context.globalStorageUri.fsPath, "renders"),
    renderPromises: new Map<string, Promise<LatexRenderResult>>()
  };
}

/* Creates render sizing settings from the active editor font size so SVG files are regenerated when source text grows or shrinks. */
export function createLatexRenderSettings(editorFontSizePixels: number): LatexRenderSettings {
  let safeFontSizePixels = editorFontSizePixels;
  if (safeFontSizePixels <= 0) {
    safeFontSizePixels = defaultEditorFontSizePixels;
  }

  const inlineSvgHeightPoints = convertCssPixelsToTexPoints(safeFontSizePixels);
  return {
    inlineSvgHeightPoints,
    hoverSvgHeightPoints: inlineSvgHeightPoints * hoverPreviewScaleFactor
  };
}

/* Renders valid snippets into SVG previews and returns a cache-keyed result map for editor decoration lookup during refresh cycles safely. */
export async function renderLatexSnippets(
  snippets: LatexSnippet[],
  latexEnvironment: LatexEnvironmentStatus | undefined,
  renderCache: LatexRenderCache,
  renderSettings: LatexRenderSettings
): Promise<Map<string, LatexRenderResult>> {
  const renderResults = new Map<string, LatexRenderResult>();

  for (const snippet of snippets) {
    const renderResult = await renderLatexSnippet(snippet, latexEnvironment, renderCache, renderSettings);
    renderResults.set(renderResult.cacheKey, renderResult);
  }

  return renderResults;
}

/* Creates a stable cache key from snippet content, render sizing, and style so identical equations reuse correct SVG files safely. */
export function createLatexRenderCacheKey(snippet: LatexSnippet, renderSettings: LatexRenderSettings): string {
  const hash = createHash("sha256");
  hash.update(renderStyleVersion);
  hash.update("\n");
  hash.update(formatSvgPointLength(renderSettings.inlineSvgHeightPoints));
  hash.update("\n");
  hash.update(formatSvgPointLength(renderSettings.hoverSvgHeightPoints));
  hash.update("\n");
  hash.update(formatSvgPointLength(hoverSvgPaddingPoints));
  hash.update("\n");
  hash.update(snippet.body);
  return hash.digest("hex");
}

/* Renders one validated snippet through LaTeX and dvisvgm, reusing cached promises and files whenever possible for editor previews inside VS Code. */
async function renderLatexSnippet(
  snippet: LatexSnippet,
  latexEnvironment: LatexEnvironmentStatus | undefined,
  renderCache: LatexRenderCache,
  renderSettings: LatexRenderSettings
): Promise<LatexRenderResult> {
  const cacheKey = createLatexRenderCacheKey(snippet, renderSettings);

  if (!snippet.validation.isValid) {
    return createSkippedRenderResult(cacheKey, snippet.validation.message);
  }

  if (latexEnvironment === undefined) {
    return createSkippedRenderResult(cacheKey, "Texcomment has not checked the LaTeX environment yet.");
  }

  if (!latexEnvironment.isAvailable) {
    return createSkippedRenderResult(cacheKey, latexEnvironment.message);
  }

  const existingRenderPromise = renderCache.renderPromises.get(cacheKey);
  if (existingRenderPromise !== undefined) {
    return existingRenderPromise;
  }

  const renderPromise = renderLatexSnippetWithSystemTools(snippet, latexEnvironment, renderCache, cacheKey, renderSettings);
  renderCache.renderPromises.set(cacheKey, renderPromise);
  return renderPromise;
}

/* Runs the system rendering pipeline for one snippet by producing DVI output, converting it, and styling SVG variants for themes. */
async function renderLatexSnippetWithSystemTools(
  snippet: LatexSnippet,
  latexEnvironment: LatexEnvironmentStatus,
  renderCache: LatexRenderCache,
  cacheKey: string,
  renderSettings: LatexRenderSettings
): Promise<LatexRenderResult> {
  try {
    await fs.mkdir(renderCache.storageDirectory, {
      recursive: true
    });

    const cachedRenderResult = await readCachedRenderResult(renderCache.storageDirectory, cacheKey);
    if (cachedRenderResult !== undefined) {
      return cachedRenderResult;
    }

    return await createRenderedSvgFiles(snippet, latexEnvironment, renderCache.storageDirectory, cacheKey, renderSettings);
  } catch (error) {
    return createSkippedRenderResult(cacheKey, readErrorMessage(error));
  }
}

/* Reads previously generated light and dark SVG files when both files still exist in the render storage directory for reuse. */
async function readCachedRenderResult(storageDirectory: string, cacheKey: string): Promise<LatexRenderResult | undefined> {
  const lightSvgPath = createInlineLightSvgPath(storageDirectory, cacheKey);
  const darkSvgPath = createInlineDarkSvgPath(storageDirectory, cacheKey);
  const lightHoverSvgPath = createHoverLightSvgPath(storageDirectory, cacheKey);
  const darkHoverSvgPath = createHoverDarkSvgPath(storageDirectory, cacheKey);
  const hasLightSvg = await pathExists(lightSvgPath);
  const hasDarkSvg = await pathExists(darkSvgPath);
  const hasLightHoverSvg = await pathExists(lightHoverSvgPath);
  const hasDarkHoverSvg = await pathExists(darkHoverSvgPath);

  if (hasLightSvg && hasDarkSvg && hasLightHoverSvg && hasDarkHoverSvg) {
    return await createRenderedResult(cacheKey, lightSvgPath, darkSvgPath, lightHoverSvgPath, darkHoverSvgPath, "Rendered from Texcomment cache.");
  }

  return undefined;
}

/* Creates temporary LaTeX files, runs latex and dvisvgm, then writes theme-specific SVG files into persistent storage for editor use later. */
async function createRenderedSvgFiles(
  snippet: LatexSnippet,
  latexEnvironment: LatexEnvironmentStatus,
  storageDirectory: string,
  cacheKey: string,
  renderSettings: LatexRenderSettings
): Promise<LatexRenderResult> {
  let temporaryDirectory = "";

  try {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "texcomment-"));
    const texFilePath = path.join(temporaryDirectory, "snippet.tex");
    const dviFilePath = path.join(temporaryDirectory, "snippet.dvi");
    const rawSvgPath = path.join(temporaryDirectory, "snippet.svg");
    const lightSvgPath = createInlineLightSvgPath(storageDirectory, cacheKey);
    const darkSvgPath = createInlineDarkSvgPath(storageDirectory, cacheKey);
    const lightHoverSvgPath = createHoverLightSvgPath(storageDirectory, cacheKey);
    const darkHoverSvgPath = createHoverDarkSvgPath(storageDirectory, cacheKey);

    await fs.writeFile(texFilePath, createLatexDocument(snippet), "utf8");
    await runLatexCommand(latexEnvironment.executablePath, texFilePath, temporaryDirectory);
    await runDvisvgmCommand(latexEnvironment.svgConverterPath, dviFilePath, rawSvgPath, temporaryDirectory);
    await writeStyledSvgVariants(rawSvgPath, lightSvgPath, darkSvgPath, lightHoverSvgPath, darkHoverSvgPath, renderSettings);

    return await createRenderedResult(cacheKey, lightSvgPath, darkSvgPath, lightHoverSvgPath, darkHoverSvgPath, "Rendered with latex and dvisvgm.");
  } finally {
    await removeTemporaryDirectory(temporaryDirectory);
  }
}

/* Builds a minimal LaTeX document using supported AMS packages and wraps each validated inline snippet with standard math delimiters safely. */
function createLatexDocument(snippet: LatexSnippet): string {
  return [
    "\\documentclass{article}",
    "\\usepackage{amsmath}",
    "\\usepackage{amssymb}",
    "\\usepackage{amsthm}",
    "\\usepackage{amsfonts}",
    "\\pagestyle{empty}",
    "\\begin{document}",
    "\\(",
    snippet.body,
    "\\)",
    "\\end{document}",
    ""
  ].join("\n");
}

/* Runs latex in nonstop mode inside the temporary directory so failed snippets return quickly without interactive prompts during rendering work. */
async function runLatexCommand(latexExecutablePath: string, texFilePath: string, temporaryDirectory: string): Promise<void> {
  await executeFile(
    latexExecutablePath,
    [
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-output-directory",
      temporaryDirectory,
      texFilePath
    ],
    {
      cwd: temporaryDirectory,
      timeout: latexProcessTimeoutMilliseconds,
      maxBuffer: latexProcessMaximumBufferBytes
    }
  );
}

/* Runs dvisvgm against the generated DVI file, cropping the SVG to the equation content for editor display previews inside VS Code. */
async function runDvisvgmCommand(
  svgConverterPath: string,
  dviFilePath: string,
  rawSvgPath: string,
  temporaryDirectory: string
): Promise<void> {
  await executeFile(
    svgConverterPath,
    [
      "--no-fonts",
      "--exact",
      "--bbox=min",
      "--output=" + rawSvgPath,
      dviFilePath
    ],
    {
      cwd: temporaryDirectory,
      timeout: latexProcessTimeoutMilliseconds,
      maxBuffer: latexProcessMaximumBufferBytes
    }
  );
}

/* Writes inline and hover SVG theme variants after resizing dimensions, padding hover canvases, and injecting glyph color rules for editor contrast support. */
async function writeStyledSvgVariants(
  rawSvgPath: string,
  lightSvgPath: string,
  darkSvgPath: string,
  lightHoverSvgPath: string,
  darkHoverSvgPath: string,
  renderSettings: LatexRenderSettings
): Promise<void> {
  const rawSvgContent = await fs.readFile(rawSvgPath, "utf8");
  const inlineSvgContent = resizeSvgContentHeight(rawSvgContent, renderSettings.inlineSvgHeightPoints);
  const resizedHoverSvgContent = resizeSvgContentHeight(rawSvgContent, renderSettings.hoverSvgHeightPoints);
  const hoverSvgContent = addSvgContentPadding(resizedHoverSvgContent, hoverSvgPaddingPoints);
  const lightSvgContent = injectSvgColorStyle(inlineSvgContent, "#1f2328");
  const darkSvgContent = injectSvgColorStyle(inlineSvgContent, "#f5f5f5");
  const lightHoverSvgContent = injectSvgColorStyle(hoverSvgContent, "#1f2328");
  const darkHoverSvgContent = injectSvgColorStyle(hoverSvgContent, "#f5f5f5");

  await fs.writeFile(lightSvgPath, lightSvgContent, "utf8");
  await fs.writeFile(darkSvgPath, darkSvgContent, "utf8");
  await fs.writeFile(lightHoverSvgPath, lightHoverSvgContent, "utf8");
  await fs.writeFile(darkHoverSvgPath, darkHoverSvgContent, "utf8");
}

/* Injects CSS into SVG content so glyphs, rule bars, and stroked symbols maintain contrast against editor themes reliably now always. */
function injectSvgColorStyle(svgContent: string, colorValue: string): string {
  const svgStartIndex = svgContent.indexOf("<svg");
  if (svgStartIndex === -1) {
    return svgContent;
  }

  const svgOpenEndIndex = svgContent.indexOf(">", svgStartIndex);
  if (svgOpenEndIndex === -1) {
    return svgContent;
  }

  const beforeSvgEnd = svgContent.substring(0, svgOpenEndIndex + 1);
  const afterSvgEnd = svgContent.substring(svgOpenEndIndex + 1);
  const styleContent = createSvgColorStyle(colorValue);

  return beforeSvgEnd + styleContent + afterSvgEnd;
}

/* Creates SVG CSS that recolors filled glyphs and stroke-based equation rules without changing layout geometry inside previews safely now always. */
function createSvgColorStyle(colorValue: string): string {
  return [
    "<style>",
    "svg{color:" + colorValue + " !important;}",
    "path,use,text,rect{fill:" + colorValue + " !important;}",
    "path[stroke],line,polyline,polygon,rect[stroke]{stroke:" + colorValue + " !important;}",
    "</style>"
  ].join("");
}

/* Creates a successful render result with inline file URIs and embedded hover SVG data for theme-specific editor previews inside VS Code. */
async function createRenderedResult(
  cacheKey: string,
  lightSvgPath: string,
  darkSvgPath: string,
  lightHoverSvgPath: string,
  darkHoverSvgPath: string,
  message: string
): Promise<LatexRenderResult> {
  const lightHoverSvgDataUri = await readSvgFileDataUri(lightHoverSvgPath);
  const darkHoverSvgDataUri = await readSvgFileDataUri(darkHoverSvgPath);

  return {
    cacheKey,
    isRendered: true,
    lightSvgUri: vscode.Uri.file(lightSvgPath),
    darkSvgUri: vscode.Uri.file(darkSvgPath),
    lightHoverSvgUri: vscode.Uri.file(lightHoverSvgPath),
    darkHoverSvgUri: vscode.Uri.file(darkHoverSvgPath),
    lightHoverSvgDataUri,
    darkHoverSvgDataUri,
    message
  };
}

/* Reads a generated SVG file and returns a data URI that is safe to embed inside VS Code hover Markdown. */
async function readSvgFileDataUri(svgPath: string): Promise<string> {
  const svgContent = await fs.readFile(svgPath, "utf8");
  return createSvgDataUri(svgContent);
}

/* Encodes SVG XML as a base64 data URI so Markdown hovers can display previews without loading local files through VS Code. */
function createSvgDataUri(svgContent: string): string {
  const encodedSvgContent = Buffer.from(svgContent, "utf8").toString("base64");
  return "data:image/svg+xml;base64," + encodedSvgContent;
}

/* Creates a non-rendered result that preserves the reason so editor hovers can explain fallback preview behavior to users during editing. */
function createSkippedRenderResult(cacheKey: string, message: string): LatexRenderResult {
  return {
    cacheKey,
    isRendered: false,
    lightSvgUri: undefined,
    darkSvgUri: undefined,
    lightHoverSvgUri: undefined,
    darkHoverSvgUri: undefined,
    lightHoverSvgDataUri: undefined,
    darkHoverSvgDataUri: undefined,
    message
  };
}

/* Rewrites SVG root dimensions to the requested TeX point height while preserving aspect ratio before editor decorations load it safely. */
function resizeSvgContentHeight(svgContent: string, targetHeightPoints: number): string {
  const svgDimensions = readSvgRootDimensions(svgContent);
  if (svgDimensions === undefined) {
    return svgContent;
  }

  const heightPoints = convertSvgLengthToPoints(svgDimensions.height);
  if (heightPoints === undefined) {
    return svgContent;
  }

  const widthPoints = convertSvgLengthToPoints(svgDimensions.width);
  if (widthPoints === undefined) {
    return svgContent;
  }

  const scaleFactor = targetHeightPoints / heightPoints;
  const scaledWidthPoints = widthPoints * scaleFactor;
  const svgWithScaledWidth = replaceSvgRootAttribute(svgContent, "width", formatSvgPointLength(scaledWidthPoints));
  return replaceSvgRootAttribute(svgWithScaledWidth, "height", formatSvgPointLength(targetHeightPoints));
}

/* Adds physical canvas padding around hover SVG content by expanding root dimensions and viewBox bounds without scaling existing equation paths. */
function addSvgContentPadding(svgContent: string, paddingPoints: number): string {
  if (paddingPoints <= 0) {
    return svgContent;
  }

  const svgDimensions = readSvgRootDimensions(svgContent);
  if (svgDimensions === undefined) {
    return svgContent;
  }

  const svgViewBox = readSvgRootViewBox(svgContent);
  if (svgViewBox === undefined) {
    return svgContent;
  }

  const widthPoints = convertSvgLengthToPoints(svgDimensions.width);
  if (widthPoints === undefined) {
    return svgContent;
  }

  if (widthPoints <= 0) {
    return svgContent;
  }

  const heightPoints = convertSvgLengthToPoints(svgDimensions.height);
  if (heightPoints === undefined) {
    return svgContent;
  }

  if (heightPoints <= 0) {
    return svgContent;
  }

  if (svgViewBox.width <= 0) {
    return svgContent;
  }

  if (svgViewBox.height <= 0) {
    return svgContent;
  }

  const horizontalPaddingUnits = paddingPoints * svgViewBox.width / widthPoints;
  const verticalPaddingUnits = paddingPoints * svgViewBox.height / heightPoints;
  const paddedWidthPoints = widthPoints + paddingPoints * 2;
  const paddedHeightPoints = heightPoints + paddingPoints * 2;
  const paddedViewBox = createPaddedSvgViewBox(svgViewBox, horizontalPaddingUnits, verticalPaddingUnits);
  const svgWithPaddedWidth = replaceSvgRootAttribute(svgContent, "width", formatSvgPointLength(paddedWidthPoints));
  const svgWithPaddedHeight = replaceSvgRootAttribute(svgWithPaddedWidth, "height", formatSvgPointLength(paddedHeightPoints));
  return replaceSvgRootAttribute(svgWithPaddedHeight, "viewBox", formatSvgViewBox(paddedViewBox));
}

interface SvgRootDimensions {
  width: string;
  height: string;
}

interface SvgViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/* Reads root SVG width and height attributes so generated equation files can be scaled before they are written into persistent storage. */
function readSvgRootDimensions(svgContent: string): SvgRootDimensions | undefined {
  const width = readSvgRootLengthAttribute(svgContent, "width");
  const height = readSvgRootLengthAttribute(svgContent, "height");

  if (width === undefined) {
    return undefined;
  }

  if (height === undefined) {
    return undefined;
  }

  return {
    width,
    height
  };
}

/* Reads the root SVG viewBox values so hover padding can expand the visible canvas around the rendered equation content safely. */
function readSvgRootViewBox(svgContent: string): SvgViewBox | undefined {
  const svgOpenTag = readSvgOpenTag(svgContent);
  if (svgOpenTag === undefined) {
    return undefined;
  }

  const attributePattern = /\sviewBox\s*=\s*['"]([^'"]+)['"]/;
  const attributeMatch = attributePattern.exec(svgOpenTag);
  if (attributeMatch === null) {
    return undefined;
  }

  const viewBoxText = attributeMatch[1].replace(/,/g, " ");
  const viewBoxParts = viewBoxText.trim().split(/\s+/);
  if (viewBoxParts.length !== 4) {
    return undefined;
  }

  const minX = Number.parseFloat(viewBoxParts[0]);
  const minY = Number.parseFloat(viewBoxParts[1]);
  const width = Number.parseFloat(viewBoxParts[2]);
  const height = Number.parseFloat(viewBoxParts[3]);

  if (!Number.isFinite(minX)) {
    return undefined;
  }

  if (!Number.isFinite(minY)) {
    return undefined;
  }

  if (!Number.isFinite(width)) {
    return undefined;
  }

  if (!Number.isFinite(height)) {
    return undefined;
  }

  return {
    minX,
    minY,
    width,
    height
  };
}

/* Creates padded viewBox coordinates by expanding each edge while preserving every existing path coordinate and rendered glyph shape inside hovers. */
function createPaddedSvgViewBox(svgViewBox: SvgViewBox, horizontalPaddingUnits: number, verticalPaddingUnits: number): SvgViewBox {
  return {
    minX: svgViewBox.minX - horizontalPaddingUnits,
    minY: svgViewBox.minY - verticalPaddingUnits,
    width: svgViewBox.width + horizontalPaddingUnits * 2,
    height: svgViewBox.height + verticalPaddingUnits * 2
  };
}

/* Formats viewBox values with stable precision so regenerated hover SVG padding avoids noisy floating point text in cached files later. */
function formatSvgViewBox(svgViewBox: SvgViewBox): string {
  return [
    formatSvgViewBoxNumber(svgViewBox.minX),
    formatSvgViewBoxNumber(svgViewBox.minY),
    formatSvgViewBoxNumber(svgViewBox.width),
    formatSvgViewBoxNumber(svgViewBox.height)
  ].join(" ");
}

/* Formats one SVG viewBox number with enough precision for padding while trimming unnecessary trailing zeros from generated cached files safely. */
function formatSvgViewBoxNumber(value: number): string {
  const fixedValue = value.toFixed(6);
  return fixedValue.replace(/\.?0+$/, "");
}

/* Reads a single root SVG length attribute from the opening tag, returning undefined when dvisvgm output lacks that dimension value. */
function readSvgRootLengthAttribute(svgContent: string, attributeName: string): string | undefined {
  const svgOpenTag = readSvgOpenTag(svgContent);
  if (svgOpenTag === undefined) {
    return undefined;
  }

  const attributePattern = new RegExp("\\s" + attributeName + "\\s*=\\s*['\\\"]([^'\\\"]+)['\\\"]");
  const attributeMatch = attributePattern.exec(svgOpenTag);
  if (attributeMatch === null) {
    return undefined;
  }

  return attributeMatch[1];
}

/* Replaces one root SVG attribute inside the opening tag while leaving paths and definitions unchanged for generated preview files. */
function replaceSvgRootAttribute(svgContent: string, attributeName: string, attributeValue: string): string {
  const svgStartIndex = svgContent.indexOf("<svg");
  if (svgStartIndex === -1) {
    return svgContent;
  }

  const svgOpenEndIndex = svgContent.indexOf(">", svgStartIndex);
  if (svgOpenEndIndex === -1) {
    return svgContent;
  }

  const beforeSvgOpenTag = svgContent.substring(0, svgStartIndex);
  const svgOpenTag = svgContent.substring(svgStartIndex, svgOpenEndIndex + 1);
  const afterSvgOpenTag = svgContent.substring(svgOpenEndIndex + 1);
  const attributePattern = new RegExp("(\\s" + attributeName + "\\s*=\\s*['\\\"])([^'\\\"]+)(['\\\"])");
  const replacementText = "$1" + attributeValue + "$3";
  const updatedSvgOpenTag = svgOpenTag.replace(attributePattern, replacementText);

  return beforeSvgOpenTag + updatedSvgOpenTag + afterSvgOpenTag;
}

/* Finds the root SVG opening tag generated by dvisvgm so dimension parsing stays focused on the actual rendered asset metadata. */
function readSvgOpenTag(svgContent: string): string | undefined {
  const svgStartIndex = svgContent.indexOf("<svg");
  if (svgStartIndex === -1) {
    return undefined;
  }

  const svgOpenEndIndex = svgContent.indexOf(">", svgStartIndex);
  if (svgOpenEndIndex === -1) {
    return undefined;
  }

  return svgContent.substring(svgStartIndex, svgOpenEndIndex + 1);
}

/* Parses an SVG length string with common dvisvgm units and converts it to TeX points for reliable height scaling decisions. */
function convertSvgLengthToPoints(lengthValue: string): number | undefined {
  const lengthNumber = readSvgLengthNumber(lengthValue);
  if (lengthNumber === undefined) {
    return undefined;
  }

  const lengthUnit = readSvgLengthUnit(lengthValue);
  if (lengthUnit === "pt") {
    return lengthNumber;
  }

  if (lengthUnit === "bp" || lengthUnit === "px") {
    return lengthNumber * texPointsPerInch / 72;
  }

  if (lengthUnit === "in") {
    return lengthNumber * texPointsPerInch;
  }

  if (lengthUnit === "cm") {
    return lengthNumber * texPointsPerInch / 2.54;
  }

  if (lengthUnit === "mm") {
    return lengthNumber * texPointsPerInch / 25.4;
  }

  return undefined;
}

/* Converts VS Code editor font pixels into TeX points so generated SVG dimensions track visible source text sizing accurately always. */
function convertCssPixelsToTexPoints(pixelValue: number): number {
  return pixelValue * texPointsPerInch / cssPixelsPerInch;
}

/* Formats a TeX point length with enough precision for SVG dimensions while avoiding noisy floating point artifacts in generated files. */
function formatSvgPointLength(lengthPoints: number): string {
  return lengthPoints.toFixed(6) + "pt";
}

/* Reads the numeric portion from an SVG length value while ignoring unsupported formats that cannot guide preview scaling decisions safely. */
function readSvgLengthNumber(lengthValue: string): number | undefined {
  const numberPattern = /^\s*(-?\d+(?:\.\d+)?|\.\d+)/;
  const numberMatch = numberPattern.exec(lengthValue);
  if (numberMatch === null) {
    return undefined;
  }

  const parsedNumber = Number.parseFloat(numberMatch[1]);
  if (Number.isNaN(parsedNumber)) {
    return undefined;
  }

  return parsedNumber;
}

/* Reads the unit suffix from an SVG length value, returning points when dvisvgm omits an explicit unit in generated output. */
function readSvgLengthUnit(lengthValue: string): string {
  const unitPattern = /([a-zA-Z]+)\s*$/;
  const unitMatch = unitPattern.exec(lengthValue);
  if (unitMatch === null) {
    return "pt";
  }

  return unitMatch[1].toLowerCase();
}

/* Creates the persistent light-theme inline SVG path for a cached equation render using its stable snippet cache key value safely. */
function createInlineLightSvgPath(storageDirectory: string, cacheKey: string): string {
  return path.join(storageDirectory, cacheKey + "-inline-light.svg");
}

/* Creates the persistent dark-theme inline SVG path for a cached equation render using its stable snippet cache key value safely. */
function createInlineDarkSvgPath(storageDirectory: string, cacheKey: string): string {
  return path.join(storageDirectory, cacheKey + "-inline-dark.svg");
}

/* Creates the persistent light-theme hover SVG path for a cached equation render using its stable snippet cache key value safely. */
function createHoverLightSvgPath(storageDirectory: string, cacheKey: string): string {
  return path.join(storageDirectory, cacheKey + "-hover-light.svg");
}

/* Creates the persistent dark-theme hover SVG path for a cached equation render using its stable snippet cache key value safely. */
function createHoverDarkSvgPath(storageDirectory: string, cacheKey: string): string {
  return path.join(storageDirectory, cacheKey + "-hover-dark.svg");
}

/* Checks whether a filesystem path exists by attempting to stat it and treating any failure as absence during rendering safely. */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/* Removes a temporary render directory after command execution, ignoring cleanup failures because previews already finished rendering successfully in VS Code sessions. */
async function removeTemporaryDirectory(temporaryDirectory: string): Promise<void> {
  if (temporaryDirectory.length === 0) {
    return;
  }

  try {
    await fs.rm(temporaryDirectory, {
      recursive: true,
      force: true
    });
  } catch {
    return;
  }
}

/* Converts unknown command or filesystem errors into readable messages for decoration hovers and fallback previews after render failures inside editors. */
function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Texcomment could not render the LaTeX snippet.";
}
