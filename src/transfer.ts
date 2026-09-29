import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  constants as zlibConstants,
  createZstdCompress,
  createZstdDecompress,
  zstdCompressSync,
} from "node:zlib";
import type { CascadeClient } from "./client.js";
import type { CopyCompression, SelectedCopyCompression } from "./types.js";

const COPY_SAMPLE_SIZE = 256 * 1024;
const COPY_MIN_COMPRESSION_SIZE = 1024 * 1024;
const COPY_COMPRESSION_THRESHOLD = 0.90;
const PROGRESS_INTERVAL_MS = 250;

const zstdOptions = {
  params: {
    [zlibConstants.ZSTD_c_compressionLevel]: 1,
  },
};

export interface CopyProgress {
  direction: "upload" | "download";
  compression: SelectedCopyCompression;
  logicalBytes: number;
  wireBytes: number;
  totalLogicalBytes: number;
}

export interface CopyTransferResult {
  compression: SelectedCopyCompression;
  logicalBytes: number;
  wireBytes: number;
  mode: number;
  ratio: number;
}

interface CopyMeta {
  compression: SelectedCopyCompression;
  logicalBytes: number;
  mode: number;
}

function ratio(logicalBytes: number, wireBytes: number): number {
  return logicalBytes === 0 ? 1 : wireBytes / logicalBytes;
}

function progressReporter(callback: ((progress: CopyProgress) => void) | undefined) {
  let lastAt = 0;
  let lastLogicalBytes = 0;
  return (progress: CopyProgress, force = false) => {
    const now = Date.now();
    const logicalStarted = lastLogicalBytes === 0 && progress.logicalBytes > 0;
    if (!force && !logicalStarted && now - lastAt < PROGRESS_INTERVAL_MS) return;
    lastAt = now;
    lastLogicalBytes = progress.logicalBytes;
    callback?.(progress);
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function selectLocalCopyCompression(
  localPath: string,
  size: number,
  requested: CopyCompression,
): Promise<SelectedCopyCompression> {
  if (requested === "none" || requested === "zstd") return requested;
  if (size < COPY_MIN_COMPRESSION_SIZE) return "none";
  const file = await open(localPath, "r");
  try {
    const sample = Buffer.allocUnsafe(Math.min(COPY_SAMPLE_SIZE, size));
    const { bytesRead } = await file.read(sample, 0, sample.length, 0);
    if (bytesRead === 0) return "none";
    const compressed = zstdCompressSync(sample.subarray(0, bytesRead), zstdOptions);
    return compressed.length <= bytesRead * COPY_COMPRESSION_THRESHOLD ? "zstd" : "none";
  } finally {
    await file.close();
  }
}

export async function uploadLocalFile(
  client: CascadeClient,
  localPath: string,
  remotePath: string,
  requestedCompression: CopyCompression,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: CopyProgress) => void;
  } = {},
): Promise<CopyTransferResult> {
  const info = await stat(localPath);
  if (!info.isFile()) throw new Error(`Copy source is not a regular file: ${localPath}`);
  const compression = await selectLocalCopyCompression(localPath, info.size, requestedCompression);
  let logicalBytes = 0;
  let wireBytes = 0;
  const report = progressReporter(options.onProgress);
  const source = createReadStream(localPath, { signal: options.signal });
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      logicalBytes += chunk.length;
      report({ direction: "upload", compression, logicalBytes, wireBytes, totalLogicalBytes: info.size });
      callback(null, chunk);
    },
  });
  let stream: NodeJS.ReadableStream = source.pipe(counter);
  const compressor = compression === "zstd" ? createZstdCompress(zstdOptions) : undefined;
  if (compressor) stream = stream.pipe(compressor);

  async function* chunks(): AsyncGenerator<Buffer> {
    for await (const chunk of stream) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }

  try {
    const result = await client.upload<CopyTransferResult>(
      {
        op: "copy_upload",
        path: remotePath,
        compression,
        mode: info.mode & 0o777,
      },
      chunks(),
      {
        signal: options.signal,
        onWireChunk(bytes) {
          wireBytes += bytes;
          report({ direction: "upload", compression, logicalBytes, wireBytes, totalLogicalBytes: info.size });
        },
      },
    );
    if (result.logicalBytes !== info.size) {
      throw new Error(`Copy upload byte mismatch: expected ${info.size}, remote wrote ${result.logicalBytes}`);
    }
    report({
      direction: "upload",
      compression,
      logicalBytes: result.logicalBytes,
      wireBytes: result.wireBytes,
      totalLogicalBytes: info.size,
    }, true);
    return { ...result, ratio: ratio(result.logicalBytes, result.wireBytes) };
  } finally {
    source.destroy();
    counter.destroy();
    compressor?.destroy();
  }
}

function waitForDrain(stream: PassThrough, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error(signal.reason ? String(signal.reason) : "aborted"));
  if (stream.destroyed) return Promise.reject(new Error("Copy download stream is closed"));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener("drain", drained);
      stream.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => {
      cleanup();
      reject(new Error(signal.reason ? String(signal.reason) : "aborted"));
    };
    stream.once("drain", drained);
    stream.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function replaceLocalFile(tempPath: string, destination: string): Promise<void> {
  await rename(tempPath, destination);
}

export async function downloadRemoteFile(
  client: CascadeClient,
  remotePath: string,
  localPath: string,
  requestedCompression: CopyCompression,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: CopyProgress) => void;
  } = {},
): Promise<CopyTransferResult> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const tempPath = path.join(
    path.dirname(localPath),
    `.${path.basename(localPath)}.pi-cascade-${process.pid}-${randomBytes(6).toString("hex")}.part`,
  );
  const input = new PassThrough({ highWaterMark: 256 * 1024 });
  let metadata: CopyMeta | undefined;
  let transferPipeline: Promise<void> | undefined;
  let drainWait: Promise<void> | undefined;
  let logicalBytes = 0;
  let wireBytes = 0;
  let committed = false;
  const report = progressReporter(options.onProgress);

  try {
    const result = await client.request<CopyTransferResult>(
      { op: "copy_download", path: remotePath, compression: requestedCompression },
      {
        signal,
        onMeta(value) {
          const candidate = value as Partial<CopyMeta> | undefined;
          if ((candidate?.compression !== "none" && candidate?.compression !== "zstd")
            || typeof candidate.logicalBytes !== "number"
            || typeof candidate.mode !== "number") {
            controller.abort("Invalid copy download metadata");
            return;
          }
          metadata = candidate as CopyMeta;
          const output = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              logicalBytes += chunk.length;
              report({
                direction: "download",
                compression: metadata!.compression,
                logicalBytes,
                wireBytes,
                totalLogicalBytes: metadata!.logicalBytes,
              });
              callback(null, chunk);
            },
          });
          transferPipeline = metadata.compression === "zstd"
            ? pipeline(input, createZstdDecompress(), counter, output, { signal })
            : pipeline(input, counter, output, { signal });
          void transferPipeline.catch((error) => controller.abort(error));
        },
        onData(data, stream) {
          if (stream !== "content") return;
          if (!metadata || !transferPipeline) {
            const error = new Error("Copy download data arrived before metadata");
            controller.abort(error);
            return Promise.reject(error);
          }
          wireBytes += data.length;
          report({
            direction: "download",
            compression: metadata.compression,
            logicalBytes,
            wireBytes,
            totalLogicalBytes: metadata.logicalBytes,
          });
          if (input.write(data)) return;
          drainWait ??= waitForDrain(input, signal).finally(() => { drainWait = undefined; });
          return drainWait;
        },
      },
    );
    if (!metadata || !transferPipeline) throw new Error("Copy download completed without metadata");
    input.end();
    await transferPipeline;
    signal.throwIfAborted();
    if (result.compression !== metadata.compression) {
      throw new Error(`Copy download compression mismatch: metadata=${metadata.compression}, result=${result.compression}`);
    }
    if (logicalBytes !== metadata.logicalBytes || logicalBytes !== result.logicalBytes) {
      throw new Error(`Copy download byte mismatch: expected ${metadata.logicalBytes}, wrote ${logicalBytes}`);
    }
    const completedFile = await open(tempPath, "r+");
    try {
      await completedFile.sync();
      await completedFile.chmod(metadata.mode & 0o777);
      await completedFile.sync();
    } finally {
      await completedFile.close();
    }
    signal.throwIfAborted();
    await replaceLocalFile(tempPath, localPath);
    committed = true;
    report({
      direction: "download",
      compression: metadata.compression,
      logicalBytes: result.logicalBytes,
      wireBytes: result.wireBytes,
      totalLogicalBytes: metadata.logicalBytes,
    }, true);
    return { ...result, ratio: ratio(result.logicalBytes, result.wireBytes) };
  } catch (error) {
    const normalized = normalizeError(error);
    controller.abort(normalized);
    input.destroy(normalized);
    await transferPipeline?.catch(() => undefined);
    throw normalized;
  } finally {
    input.destroy();
    if (!committed) await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
