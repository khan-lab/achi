/**
 * Input files from disk, read as the web app reads uploads: .gz by name,
 * the same size limits (inputValidation.ts), cleaned to BED text with the
 * same warnings, and named after the file.
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";
import { checkFileSize, defaultSetCode, prepareRegionText, setNameFromFileName, type InputFormat } from "@achi/core/inputValidation";

export type InputFile =
  | { ok: true; name: string; code: string; fileName: string; file: Blob; format: InputFormat; nRegions: number; warnings: string[] }
  | { ok: false; message: string };

export async function readInputFile(path: string): Promise<InputFile> {
  const fileName = basename(path);
  const gz = /\.gz$/i.test(fileName);
  let text: string;
  try {
    const tooBig = checkFileSize((await stat(path)).size);
    if (tooBig) return { ok: false, message: `${fileName} ${tooBig}` };
    const bytes = await readFile(path);
    text = gz ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  } catch {
    return { ok: false, message: `${fileName} could not be read${gz ? " — is it really gzip-compressed?" : "."}` };
  }
  const tooBigUnzipped = checkFileSize(text.length);
  if (tooBigUnzipped) return { ok: false, message: `${fileName} (uncompressed) ${tooBigUnzipped}` };
  const prepared = prepareRegionText(text, fileName);
  if (!prepared.ok) return prepared;
  const name = setNameFromFileName(fileName);
  return { ok: true, name, code: defaultSetCode(name), fileName, file: new Blob([prepared.bedText]), format: prepared.format, nRegions: prepared.nRegions, warnings: prepared.warnings };
}
